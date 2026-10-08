import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheService } from "../src/services/cacheService.js";

afterEach(() => vi.useRealTimers());

function createCache(kind: "asset" | "config" | "pending") {
  const service = new CacheService(
    { pendingEvent: { upsert: vi.fn() } } as any,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    null,
    2
  );
  const put = async (key: string, revision = 0) => {
    if (kind === "asset") {
      await service.setAssetMetadata({ asset: key, decimals: revision, lastUpdated: new Date() });
    } else if (kind === "config") {
      await service.setProtocolConfig({ key, value: revision, updatedAt: new Date() });
    } else {
      await service.setPendingEvent({
        txHash: key,
        sorobanEventId: key,
        eventPayload: revision,
        statusHint: "confirmed",
        receivedAt: new Date()
      });
    }
  };
  const get = (key: string) => {
    if (kind === "asset") return service.getAssetMetadata(key);
    if (kind === "config") return service.getProtocolConfig(key);
    return service.getPendingEvent(key);
  };
  return { service, put, get };
}

describe("in-memory cache capacity", () => {
  for (const kind of ["asset", "config", "pending"] as const) {
    describe(kind, () => {
      it.each([
        ["advancing clock", [1000, 2000, 3000, 4000]],
        ["same millisecond", [1000, 1000, 1000, 1000]],
        ["backwards clock", [4000, 3000, 2000, 1000]]
      ] as const)("evicts the least recently accessed entry with %s", async (_clock, times) => {
        vi.useFakeTimers();
        const { put, get } = createCache(kind);

        vi.setSystemTime(times[0]);
        await put("first");
        vi.setSystemTime(times[1]);
        await put("second");
        vi.setSystemTime(times[2]);
        expect(await get("first")).not.toBeNull();
        vi.setSystemTime(times[3]);
        await put("third");

        expect(await get("second")).toBeNull();
        expect(await get("first")).not.toBeNull();
        expect(await get("third")).not.toBeNull();
      });

      it("promotes replacements without making misses entries, and supports reset", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const { service, put, get } = createCache(kind);
        await put("first");
        await put("second");
        await put("first", 7);
        expect(await get("missing")).toBeNull();
        await put("third");

        expect(await get("second")).toBeNull();
        const field = kind === "asset" ? "decimals" : kind === "config" ? "value" : "eventPayload";
        expect(await get("first")).toMatchObject({ [field]: 7 });
        expect(await get("third")).not.toBeNull();
        await service.reset();
        for (const key of ["first", "second", "third"]) {
          expect(await get(key)).toBeNull();
        }
      });
    });
  }
});
