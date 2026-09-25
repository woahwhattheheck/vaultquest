import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import {
  JobLeaseService,
  InMemoryJobLeaseStore
} from "../src/services/jobLeaseService.js";

const logger = pino({ level: "silent" });

function makeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe("InMemoryJobLeaseStore", () => {
  it("allows only one owner under contention", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 5_000, t0);
    const b = await store.tryAcquire("job-a", "owner-2", 5_000, t0);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    if (!b.acquired) expect(b.reason).toBe("held_by_other");
  });

  it("recovers a crashed owner after lease expiry", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 1_000, t0);
    expect(a.acquired).toBe(true);

    const t1 = new Date(t0.getTime() + 1_001);
    const b = await store.tryAcquire("job-a", "owner-2", 1_000, t1);
    expect(b.acquired).toBe(true);
    if (a.acquired && b.acquired) {
      expect(b.fenceToken).toBe(a.fenceToken + BigInt(1));
    }
  });

  it("rejects renew and release from a stale fence", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 1_000, t0);
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;

    const t1 = new Date(t0.getTime() + 2_000);
    const b = await store.tryAcquire("job-a", "owner-2", 5_000, t1);
    expect(b.acquired).toBe(true);
    if (!b.acquired) return;

    const renew = await store.renew("job-a", "owner-1", a.fenceToken, 5_000, t1);
    expect(renew.renewed).toBe(false);
    if (!renew.renewed) expect(renew.reason).toBe("lost_fence");

    const released = await store.release("job-a", "owner-1", a.fenceToken);
    expect(released).toBe(false);

    const renew2 = await store.renew("job-a", "owner-2", b.fenceToken, 5_000, t1);
    expect(renew2.renewed).toBe(true);
  });

  it("same owner reacquire bumps fence (restart safety)", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 5_000, t0);
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;

    const b = await store.tryAcquire("job-a", "owner-1", 5_000, t0);
    expect(b.acquired).toBe(true);
    if (!b.acquired) return;
    expect(b.fenceToken).toBe(a.fenceToken + BigInt(1));

    const staleRenew = await store.renew("job-a", "owner-1", a.fenceToken, 5_000, t0);
    expect(staleRenew.renewed).toBe(false);
  });
});

describe("JobLeaseService.runWithLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs work for the lease holder and skips the contender", async () => {
    const store = new InMemoryJobLeaseStore();
    const clock = makeClock(Date.parse("2026-09-25T00:00:00.000Z"));

    const a = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-a",
      ttlMs: 5_000,
      heartbeatMs: 60_000,
      now: clock.now
    });
    const b = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-b",
      ttlMs: 5_000,
      heartbeatMs: 60_000,
      now: clock.now
    });

    let ran = 0;
    const first = a.runWithLease("cron:reconciler", async () => {
      ran += 1;
      return "ok";
    });
    await Promise.resolve();
    const second = await b.runWithLease("cron:reconciler", async () => {
      ran += 1;
      return "nope";
    });
    const firstResult = await first;

    expect(firstResult.status).toBe("ran");
    expect(second.status).toBe("skipped");
    expect(ran).toBe(1);
  });

  it("skips overlapping ticks in the same process", async () => {
    const store = new InMemoryJobLeaseStore();
    const svc = new JobLeaseService({
      logger,
      store,
      ownerId: "solo",
      ttlMs: 30_000,
      heartbeatMs: 60_000
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = svc.runWithLease("cron:quest", async () => {
      await gate;
      return 1;
    });
    await Promise.resolve();
    const overlap = await svc.runWithLease("cron:quest", async () => 2);
    release();
    const firstResult = await first;

    expect(firstResult.status).toBe("ran");
    expect(overlap.status).toBe("skipped");
    if (overlap.status === "skipped") expect(overlap.reason).toBe("local_overlap");
  });

  it("marks fence_lost when another owner steals after expiry mid-run", async () => {
    const store = new InMemoryJobLeaseStore();
    const clock = makeClock(Date.parse("2026-09-25T00:00:00.000Z"));

    const a = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-a",
      ttlMs: 1_000,
      heartbeatMs: 200,
      now: clock.now
    });
    const b = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-b",
      ttlMs: 5_000,
      heartbeatMs: 60_000,
      now: clock.now
    });

    const resultPromise = a.runWithLease("cron:indexer", async ({ signal }) => {
      clock.advance(1_500);
      const stolen = await b.runWithLease("cron:indexer", async () => "stolen");
      expect(stolen.status).toBe("ran");
      await vi.advanceTimersByTimeAsync(250);
      expect(signal.aborted).toBe(true);
      return "stale";
    });

    const result = await resultPromise;
    expect(result.status).toBe("fence_lost");
  });

  it("releases leases on shutdown so another replica can acquire", async () => {
    const store = new InMemoryJobLeaseStore();
    const a = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-a",
      ttlMs: 30_000,
      heartbeatMs: 60_000
    });
    const b = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-b",
      ttlMs: 30_000,
      heartbeatMs: 60_000
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const running = a.runWithLease("cron:backup", async () => {
      await gate;
      return true;
    });
    await Promise.resolve();

    const blocked = await b.runWithLease("cron:backup", async () => false);
    expect(blocked.status).toBe("skipped");

    await a.shutdown();
    release();
    await running;

    const after = await b.runWithLease("cron:backup", async () => true);
    expect(after.status).toBe("ran");
  });
});
