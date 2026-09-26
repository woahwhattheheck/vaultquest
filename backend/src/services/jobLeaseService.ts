import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

export type LeaseAcquisition =
  | { acquired: true; fenceToken: bigint; ownerId: string; expiresAt: Date }
  | { acquired: false; reason: "held_by_other" | "clock_skew" | "store_error"; holder?: string };

export type LeaseRenewal =
  | { renewed: true; expiresAt: Date }
  | { renewed: false; reason: "lost_fence" | "expired" | "store_error" };

export interface JobLeaseStore {
  tryAcquire(jobName: string, ownerId: string, ttlMs: number, now?: Date): Promise<LeaseAcquisition>;
  renew(jobName: string, ownerId: string, fenceToken: bigint, ttlMs: number, now?: Date): Promise<LeaseRenewal>;
  release(jobName: string, ownerId: string, fenceToken: bigint): Promise<boolean>;
}

export type RunWithLeaseResult<T> =
  | { status: "ran"; value: T; fenceToken: bigint }
  | { status: "skipped"; reason: string }
  | { status: "fence_lost"; error?: unknown };

export type JobLeaseServiceOptions = {
  /** Required unless `store` is provided (tests). */
  prisma?: PrismaClient;
  logger: Logger;
  /** Stable owner id for this process. Defaults to hostname:pid:uuid. */
  ownerId?: string;
  /** Lease TTL. Must exceed max expected tick duration + heartbeat interval. */
  ttlMs?: number;
  /** Heartbeat cadence while a job is running. */
  heartbeatMs?: number;
  /** Optional injectable store (tests). Defaults to PrismaJobLeaseStore. */
  store?: JobLeaseStore;
  /** Clock for tests. */
  now?: () => Date;
};

/**
 * Distributed job lease manager (#93).
 *
 * Guarantees:
 * - At most one owner holds a named lease across replicas.
 * - Heartbeats renew the lease; a stale owner is recoverable after expiry.
 * - fenceToken is monotonic per job; a worker that lost the fence cannot renew
 *   or release, and runWithLease aborts before returning success.
 */
export class JobLeaseService {
  readonly ownerId: string;
  private readonly store: JobLeaseStore;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  private readonly active = new Map<
    string,
    { fenceToken: bigint; heartbeat: NodeJS.Timeout; abort: AbortController }
  >();
  private shuttingDown = false;

  constructor(opts: JobLeaseServiceOptions) {
    this.ownerId = opts.ownerId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    if (opts.store) {
      this.store = opts.store;
    } else if (opts.prisma) {
      this.store = new PrismaJobLeaseStore(opts.prisma);
    } else {
      throw new Error("JobLeaseService requires prisma or store");
    }
    this.logger = opts.logger;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.heartbeatMs = opts.heartbeatMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3));
    this.now = opts.now ?? (() => new Date());
  }

  /** In-process overlap guard + distributed lease for a named job tick. */
  async runWithLease<T>(
    jobName: string,
    work: (ctx: { fenceToken: bigint; signal: AbortSignal; ownerId: string }) => Promise<T>
  ): Promise<RunWithLeaseResult<T>> {
    if (this.shuttingDown) {
      return { status: "skipped", reason: "shutting_down" };
    }
    if (this.active.has(jobName)) {
      this.logger.info({ jobName }, "job lease skipped: local overlap");
      return { status: "skipped", reason: "local_overlap" };
    }

    const acquisition = await this.store.tryAcquire(jobName, this.ownerId, this.ttlMs, this.now());
    if (!acquisition.acquired) {
      this.logger.info(
        { jobName, reason: acquisition.reason, holder: acquisition.holder },
        "job lease skipped: not acquired"
      );
      return { status: "skipped", reason: acquisition.reason };
    }

    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.heartbeat(jobName, acquisition.fenceToken, abort);
    }, this.heartbeatMs);
    // Allow process to exit even if a heartbeat timer is pending.
    heartbeat.unref?.();

    this.active.set(jobName, { fenceToken: acquisition.fenceToken, heartbeat, abort });

    try {
      const value = await work({
        fenceToken: acquisition.fenceToken,
        signal: abort.signal,
        ownerId: this.ownerId
      });
      if (abort.signal.aborted) {
        return { status: "fence_lost" };
      }
      return { status: "ran", value, fenceToken: acquisition.fenceToken };
    } catch (error) {
      if (abort.signal.aborted) {
        return { status: "fence_lost", error };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.active.delete(jobName);
      try {
        await this.store.release(jobName, this.ownerId, acquisition.fenceToken);
      } catch (err) {
        this.logger.warn({ err, jobName }, "job lease release failed");
      }
    }
  }

  /** Release all held leases (graceful shutdown). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = [...this.active.entries()];
    for (const [jobName, state] of entries) {
      state.abort.abort();
      clearInterval(state.heartbeat);
      this.active.delete(jobName);
      try {
        await this.store.release(jobName, this.ownerId, state.fenceToken);
      } catch (err) {
        this.logger.warn({ err, jobName }, "job lease release on shutdown failed");
      }
    }
  }

  private async heartbeat(jobName: string, fenceToken: bigint, abort: AbortController): Promise<void> {
    if (abort.signal.aborted) return;
    try {
      const result = await this.store.renew(jobName, this.ownerId, fenceToken, this.ttlMs, this.now());
      if (!result.renewed) {
        this.logger.warn({ jobName, reason: result.reason, fenceToken: fenceToken.toString() }, "job lease fence lost");
        abort.abort();
      }
    } catch (err) {
      this.logger.warn({ err, jobName }, "job lease heartbeat failed");
      abort.abort();
    }
  }
}

/**
 * Postgres-backed lease store using compare-and-set fencing tokens.
 *
 * Acquire steals only when the existing lease is expired (or absent). Renew
 * and release require the caller to present the current owner+fence pair.
 */
export class PrismaJobLeaseStore implements JobLeaseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async tryAcquire(
    jobName: string,
    ownerId: string,
    ttlMs: number,
    now: Date = new Date()
  ): Promise<LeaseAcquisition> {
    const expiresAt = new Date(now.getTime() + ttlMs);

    // Fast path: insert when absent.
    try {
      const created = await this.prisma.jobLease.create({
        data: {
          jobName,
          ownerId,
          fenceToken: BigInt(1),
          expiresAt,
          heartbeatAt: now
        }
      });
      return { acquired: true, fenceToken: created.fenceToken, ownerId, expiresAt: created.expiresAt };
    } catch (err: any) {
      // Unique violation → fall through to steal/reacquire path.
      if (err?.code !== "P2002") {
        return { acquired: false, reason: "store_error" };
      }
    }

    // Steal when expired, or renew fence when we already own it (process restart).
    const rows = await this.prisma.$queryRaw<
      Array<{ owner_id: string; fence_token: bigint; expires_at: Date }>
    >`
      UPDATE job_leases
      SET
        owner_id = ${ownerId},
        fence_token = fence_token + 1,
        expires_at = ${expiresAt},
        heartbeat_at = ${now},
        updated_at = ${now}
      WHERE job_name = ${jobName}
        AND (expires_at < ${now} OR owner_id = ${ownerId})
      RETURNING owner_id, fence_token, expires_at
    `;

    const row = rows[0];
    if (row) {
      return {
        acquired: true,
        fenceToken: row.fence_token,
        ownerId: row.owner_id,
        expiresAt: row.expires_at
      };
    }

    const held = await this.prisma.jobLease.findUnique({ where: { jobName } });
    return {
      acquired: false,
      reason: "held_by_other",
      holder: held?.ownerId
    };
  }

  async renew(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    ttlMs: number,
    now: Date = new Date()
  ): Promise<LeaseRenewal> {
    const expiresAt = new Date(now.getTime() + ttlMs);
    const result = await this.prisma.jobLease.updateMany({
      where: {
        jobName,
        ownerId,
        fenceToken,
        expiresAt: { gte: now }
      },
      data: {
        expiresAt,
        heartbeatAt: now
      }
    });
    if (result.count === 1) {
      return { renewed: true, expiresAt };
    }
    const current = await this.prisma.jobLease.findUnique({ where: { jobName } });
    if (!current || current.expiresAt < now) {
      return { renewed: false, reason: "expired" };
    }
    return { renewed: false, reason: "lost_fence" };
  }

  async release(jobName: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    // Keep the row so the next acquisition increments the existing fence token.
    // Deleting it would reset the token to 1 after every successful run.
    const result = await this.prisma.jobLease.updateMany({
      where: { jobName, ownerId, fenceToken },
      data: { ownerId: "", expiresAt: new Date(0) }
    });
    return result.count === 1;
  }
}

/**
 * In-memory lease store for multi-process contention tests without Docker.
 * Simulates shared state across JobLeaseService instances that share one store.
 */
export class InMemoryJobLeaseStore implements JobLeaseStore {
  private readonly leases = new Map<
    string,
    { ownerId: string; fenceToken: bigint; expiresAt: number; heartbeatAt: number }
  >();

  async tryAcquire(
    jobName: string,
    ownerId: string,
    ttlMs: number,
    now: Date = new Date()
  ): Promise<LeaseAcquisition> {
    const nowMs = now.getTime();
    const existing = this.leases.get(jobName);
    if (existing && existing.expiresAt >= nowMs && existing.ownerId !== ownerId) {
      return { acquired: false, reason: "held_by_other", holder: existing.ownerId };
    }
    const fenceToken = existing ? existing.fenceToken + BigInt(1) : BigInt(1);
    const expiresAt = nowMs + ttlMs;
    this.leases.set(jobName, { ownerId, fenceToken, expiresAt, heartbeatAt: nowMs });
    return { acquired: true, fenceToken, ownerId, expiresAt: new Date(expiresAt) };
  }

  async renew(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    ttlMs: number,
    now: Date = new Date()
  ): Promise<LeaseRenewal> {
    const nowMs = now.getTime();
    const existing = this.leases.get(jobName);
    if (!existing) return { renewed: false, reason: "expired" };
    if (existing.expiresAt < nowMs) return { renewed: false, reason: "expired" };
    if (existing.ownerId !== ownerId || existing.fenceToken !== fenceToken) {
      return { renewed: false, reason: "lost_fence" };
    }
    const expiresAt = nowMs + ttlMs;
    existing.expiresAt = expiresAt;
    existing.heartbeatAt = nowMs;
    return { renewed: true, expiresAt: new Date(expiresAt) };
  }

  async release(jobName: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    const existing = this.leases.get(jobName);
    if (!existing) return false;
    if (existing.ownerId !== ownerId || existing.fenceToken !== fenceToken) return false;
    existing.ownerId = "";
    existing.expiresAt = 0;
    return true;
  }

  /** Test helper: inspect current lease. */
  peek(jobName: string) {
    return this.leases.get(jobName);
  }
}
