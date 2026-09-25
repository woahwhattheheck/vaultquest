import { describe, expect, it, vi, afterEach } from "vitest";
import {
  FEE_STALE_AFTER_MS,
  buildStellarFeeEstimate,
  classifyFeeFreshness,
  fetchStellarFeeStats,
  resolveStellarHorizonUrl,
} from "@/lib/chain-fee-adapters";

describe("resolveStellarHorizonUrl", () => {
  it("prefers custom Horizon over network defaults", () => {
    expect(
      resolveStellarHorizonUrl({
        networkType: "mainnet",
        customHorizonUrl: "https://my-horizon.example/",
      }),
    ).toBe("https://my-horizon.example");
  });

  it("uses mainnet and testnet Horizon defaults", () => {
    expect(resolveStellarHorizonUrl({ networkType: "mainnet" })).toBe(
      "https://horizon.stellar.org",
    );
    expect(resolveStellarHorizonUrl({ networkType: "testnet" })).toBe(
      "https://horizon-testnet.stellar.org",
    );
  });

  it("uses a stored custom Horizon when it differs from the default", () => {
    expect(
      resolveStellarHorizonUrl({
        networkType: "testnet",
        storedHorizonUrl: "https://custom-horizon.test",
      }),
    ).toBe("https://custom-horizon.test");
  });
});

describe("buildStellarFeeEstimate", () => {
  it("combines base fee, tier multiplier, and simulation resource fee", () => {
    const estimate = buildStellarFeeEstimate({
      baseFeeStroops: 200,
      simulationResourceFee: 4800,
      multiplier: 1.25,
      sourceLedger: "42",
      fetchedAt: new Date(),
      networkType: "testnet",
      priorityKey: "high",
    });
    expect(estimate.type).toBe("stellar");
    expect(estimate.baseFeeStroops).toBe(250);
    expect(estimate.resourceFeeStroops).toBe(4800);
    expect(estimate.feeStroops).toBe(5050);
    expect(estimate.sourceLedger).toBe("42");
    expect(estimate.isStale).toBe(false);
    expect(estimate.feeBid).toMatch(/XLM$/);
  });

  it("marks unsupported or missing ledger estimates as stale", () => {
    expect(
      buildStellarFeeEstimate({
        sourceLedger: null,
        fetchedAt: new Date(),
      }).isStale,
    ).toBe(true);
    expect(
      buildStellarFeeEstimate({
        sourceLedger: "1",
        fetchedAt: new Date(),
        isUnsupported: true,
      }).unsupported,
    ).toBe(true);
  });
});

describe("classifyFeeFreshness", () => {
  it("classifies fresh, stale, and unsupported states", () => {
    const now = Date.now();
    expect(
      classifyFeeFreshness({
        fetchedAt: new Date(now - 1_000),
        sourceLedger: "9",
        now,
      }),
    ).toBe("fresh");
    expect(
      classifyFeeFreshness({
        fetchedAt: new Date(now - FEE_STALE_AFTER_MS - 1),
        sourceLedger: "9",
        now,
      }),
    ).toBe("stale");
    expect(classifyFeeFreshness({ isUnsupported: true })).toBe("unsupported");
  });
});

describe("fetchStellarFeeStats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Horizon fee_stats for testnet", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ last_ledger: 111, last_ledger_base_fee: 130 }),
    });
    const result = await fetchStellarFeeStats({
      networkType: "testnet",
      customHorizonUrl: "https://horizon-testnet.stellar.org",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://horizon-testnet.stellar.org/fee_stats",
      expect.any(Object),
    );
    expect(result.baseFeeStroops).toBe(130);
    expect(result.sourceLedger).toBe("111");
    expect(result.fresh).toBe(true);
  });

  it("throws on Horizon HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(
      fetchStellarFeeStats({
        customHorizonUrl: "https://horizon.example",
        fetchImpl,
      }),
    ).rejects.toThrow(/503/);
  });
});
