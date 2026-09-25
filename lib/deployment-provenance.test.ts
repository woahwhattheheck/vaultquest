import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROVENANCE,
  RPC_STALE_LATENCY_MS,
  aggregateAdminHealth,
  detectConfigDrift,
  evaluateIndexerHealth,
  evaluateRpcHealth,
  verifyContractProvenance,
  worstHealth,
} from "./deployment-provenance";

const NOW = new Date("2026-09-25T18:00:00.000Z");

const baseProvenance = {
  ...CANONICAL_PROVENANCE,
  contract: {
    ...CANONICAL_PROVENANCE.contract,
    contractId: "CA_TEST_DRIP_POOL",
    expectedWasmHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
};

describe("worstHealth", () => {
  it("prefers degraded over stale over healthy", () => {
    expect(worstHealth("healthy", "stale")).toBe("stale");
    expect(worstHealth("stale", "degraded", "healthy")).toBe("degraded");
    expect(worstHealth("healthy", "healthy")).toBe("healthy");
  });
});

describe("evaluateRpcHealth", () => {
  it("marks a fast matching RPC as healthy", () => {
    const report = evaluateRpcHealth(
      {
        ok: true,
        latencyMs: 120,
        networkPassphrase: baseProvenance.network.passphrase,
      },
      baseProvenance,
      NOW,
    );
    expect(report.status).toBe("healthy");
    expect(report.kind).toBe("rpc");
    expect(report.remediationUrl).toContain("ADMIN_HEALTH_REMEDIATION");
  });

  it("marks elevated latency as stale", () => {
    const report = evaluateRpcHealth(
      { ok: true, latencyMs: RPC_STALE_LATENCY_MS, networkPassphrase: baseProvenance.network.passphrase },
      baseProvenance,
      NOW,
    );
    expect(report.status).toBe("stale");
    expect(report.detail).toMatch(/latency/i);
  });

  it("marks unreachable or mismatched network as degraded", () => {
    expect(
      evaluateRpcHealth(
        { ok: false, latencyMs: 40, error: "connection refused" },
        baseProvenance,
        NOW,
      ).status,
    ).toBe("degraded");

    expect(
      evaluateRpcHealth(
        {
          ok: true,
          latencyMs: 80,
          networkPassphrase: "Public Global Stellar Network ; September 2015",
        },
        baseProvenance,
        NOW,
      ).status,
    ).toBe("degraded");
  });
});

describe("evaluateIndexerHealth", () => {
  it("marks a fresh low-lag indexer as healthy", () => {
    const report = evaluateIndexerHealth(
      {
        status: "healthy",
        latestLedger: 1_500_000,
        syncLag: 2,
        lastSuccessSyncTime: "2026-09-25T17:59:00.000Z",
        lastError: null,
        message: "Indexer is healthy and syncing",
      },
      baseProvenance,
      NOW,
    );
    expect(report.status).toBe("healthy");
  });

  it("marks soft lag / lagging backend status as stale", () => {
    expect(
      evaluateIndexerHealth(
        {
          status: "lagging",
          latestLedger: 1_500_000,
          syncLag: baseProvenance.indexer.softLagLedgers,
          lastSuccessSyncTime: "2026-09-25T17:59:00.000Z",
        },
        baseProvenance,
        NOW,
      ).status,
    ).toBe("stale");

    expect(
      evaluateIndexerHealth(
        {
          status: "healthy",
          syncLag: 0,
          lastSuccessSyncTime: "2026-09-25T17:50:00.000Z",
        },
        baseProvenance,
        NOW,
      ).status,
    ).toBe("stale");
  });

  it("marks hard lag or last_error as degraded", () => {
    expect(
      evaluateIndexerHealth(
        {
          status: "degraded",
          syncLag: 10,
          lastError: "Horizon RPC rate limit exceeded (HTTP 429)",
        },
        baseProvenance,
        NOW,
      ).status,
    ).toBe("degraded");

    expect(
      evaluateIndexerHealth(
        {
          status: "healthy",
          syncLag: baseProvenance.indexer.hardLagLedgers,
          lastSuccessSyncTime: "2026-09-25T17:59:00.000Z",
        },
        baseProvenance,
        NOW,
      ).status,
    ).toBe("degraded");
  });
});

describe("verifyContractProvenance", () => {
  it("marks matching hashes as healthy", () => {
    expect(
      verifyContractProvenance(
        baseProvenance.contract.expectedWasmHash,
        baseProvenance,
        NOW,
      ).status,
    ).toBe("healthy");
  });

  it("marks missing or mismatched hashes as degraded", () => {
    expect(verifyContractProvenance(null, baseProvenance, NOW).status).toBe(
      "degraded",
    );
    expect(
      verifyContractProvenance(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        baseProvenance,
        NOW,
      ).status,
    ).toBe("degraded");
  });
});

describe("detectConfigDrift", () => {
  it("reports healthy when runtime matches canonical provenance", () => {
    const report = detectConfigDrift(
      {
        ...baseProvenance.protocolParameters,
        contractId: baseProvenance.contract.contractId,
      },
      baseProvenance,
      NOW,
    );
    expect(report.status).toBe("healthy");
    expect(report.hasDrift).toBe(false);
  });

  it("marks non-critical drift as stale and critical drift as degraded", () => {
    const warning = detectConfigDrift(
      {
        ...baseProvenance.protocolParameters,
        roundDuration: "14 days",
      },
      baseProvenance,
      NOW,
    );
    expect(warning.status).toBe("stale");
    expect(warning.drifts[0].severity).toBe("warning");

    const critical = detectConfigDrift(
      {
        ...baseProvenance.protocolParameters,
        treasuryFee: "2.00%",
        contractId: "CA_OTHER",
      },
      baseProvenance,
      NOW,
    );
    expect(critical.status).toBe("degraded");
    expect(critical.drifts.some((d) => d.severity === "critical")).toBe(true);
  });
});

describe("aggregateAdminHealth", () => {
  it("rolls up healthy / stale / degraded dependency counts", () => {
    const rpc = evaluateRpcHealth(
      { ok: true, latencyMs: 50, networkPassphrase: baseProvenance.network.passphrase },
      baseProvenance,
      NOW,
    );
    const indexer = evaluateIndexerHealth(
      {
        status: "lagging",
        syncLag: baseProvenance.indexer.softLagLedgers,
        lastSuccessSyncTime: "2026-09-25T17:59:00.000Z",
      },
      baseProvenance,
      NOW,
    );
    const contract = verifyContractProvenance(
      baseProvenance.contract.expectedWasmHash,
      baseProvenance,
      NOW,
    );
    const configDrift = detectConfigDrift(
      baseProvenance.protocolParameters,
      baseProvenance,
      NOW,
    );

    const overview = aggregateAdminHealth({
      rpc,
      indexer,
      contract,
      configDrift,
      checkedAt: NOW.toISOString(),
    });

    expect(overview.status).toBe("stale");
    expect(overview.summary).toEqual({
      healthy: 3,
      stale: 1,
      degraded: 0,
      total: 4,
    });
    expect(overview.dependencies.map((d) => d.id)).toEqual([
      "rpc",
      "indexer",
      "contract_hash",
      "config_drift",
    ]);
  });

  it("surfaces overall degraded when any dependency is degraded", () => {
    const overview = aggregateAdminHealth({
      rpc: evaluateRpcHealth(
        { ok: false, latencyMs: 0, error: "down" },
        baseProvenance,
        NOW,
      ),
      indexer: evaluateIndexerHealth(
        {
          status: "healthy",
          syncLag: 0,
          lastSuccessSyncTime: "2026-09-25T17:59:00.000Z",
        },
        baseProvenance,
        NOW,
      ),
      contract: verifyContractProvenance(
        baseProvenance.contract.expectedWasmHash,
        baseProvenance,
        NOW,
      ),
      configDrift: detectConfigDrift(
        baseProvenance.protocolParameters,
        baseProvenance,
        NOW,
      ),
      checkedAt: NOW.toISOString(),
    });
    expect(overview.status).toBe("degraded");
    expect(overview.summary.degraded).toBe(1);
  });
});
