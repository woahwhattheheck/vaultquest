import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheService } from "../src/services/cacheService.js";

afterEach(() => vi.useRealTimers());

describe("in-memory cache capacity", () => {
  it.each(["asset", "config", "pending"] as const)(
    "evicts the least recently accessed %s entry when capacity is exceeded",
    async (kind) => {
      vi.useFakeTimers();
      const service = new CacheService(
        { pendingEvent: { upsert: vi.fn() } } as any,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        null,
        2
      );

      const put = async (key: string) => {
        if (kind === "asset") {
          await service.setAssetMetadata({ asset: key, decimals: 7, lastUpdated: new Date() });
        } else if (kind === "config") {
          await service.setProtocolConfig({ key, value: key, updatedAt: new Date() });
        } else {
          await service.setPendingEvent({
            txHash: key,
            sorobanEventId: key,
            eventPayload: {},
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

      vi.setSystemTime(1000);
      await put("first");
      vi.setSystemTime(2000);
      await put("second");
      vi.setSystemTime(3000);
      expect(await get("first")).not.toBeNull();
      vi.setSystemTime(4000);
      await put("third");

      expect(await get("second")).toBeNull();
      expect(await get("first")).not.toBeNull();
      expect(await get("third")).not.toBeNull();
    }
  );
});
