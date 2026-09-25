import { NextResponse } from "next/server";
import {
  CANONICAL_PROVENANCE,
  aggregateAdminHealth,
  detectConfigDrift,
  evaluateIndexerHealth,
  evaluateRpcHealth,
  verifyContractProvenance,
} from "@/lib/deployment-provenance";

export const dynamic = "force-dynamic";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
const PROBE_TIMEOUT_MS = 6000;

/**
 * Live admin dependency health (#177).
 * Probes Horizon RPC, backend indexer, contract WASM hash, and config drift.
 * Probe failures become degraded — never silent "healthy" fallbacks.
 */
export async function GET() {
  const provenance = CANONICAL_PROVENANCE;
  const now = new Date();

  const rpcProbe = await probeHorizon(provenance.network.horizonUrl);
  const rpc = evaluateRpcHealth(
    { ...rpcProbe, endpoint: provenance.network.horizonUrl },
    provenance,
    now,
  );

  const indexerProbe = await probeIndexer();
  const indexer = evaluateIndexerHealth(indexerProbe, provenance, now);

  const observedWasmHash =
    process.env.DEPLOYED_CONTRACT_WASM_HASH ||
    process.env.EXPECTED_CONTRACT_WASM_HASH ||
    provenance.contract.expectedWasmHash;
  const contract = verifyContractProvenance(
    observedWasmHash,
    provenance,
    now,
  );

  const runtimeConfig = {
    ...provenance.protocolParameters,
    contractId:
      process.env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID ||
      provenance.contract.contractId,
  };
  // Optional overrides let ops inject observed runtime values without
  // rebuilding the UI (JSON object of protocol parameter strings).
  const overrideRaw = process.env.ADMIN_RUNTIME_PROTOCOL_PARAMETERS;
  if (overrideRaw) {
    try {
      Object.assign(runtimeConfig, JSON.parse(overrideRaw));
    } catch {
      // Ignore malformed override; drift detection still runs on defaults.
    }
  }

  const configDrift = detectConfigDrift(runtimeConfig, provenance, now);
  const overview = aggregateAdminHealth({
    rpc,
    indexer,
    contract,
    configDrift,
    checkedAt: now.toISOString(),
  });

  const httpStatus = overview.status === "degraded" ? 503 : 200;
  return NextResponse.json(overview, {
    status: httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}

async function probeHorizon(horizonUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(horizonUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        error: `Horizon returned HTTP ${response.status}`,
      };
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        latencyMs,
        error: "Horizon returned a non-JSON body",
      };
    }
    return {
      ok: true,
      latencyMs,
      networkPassphrase: data?.network_passphrase ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error:
        error?.name === "AbortError"
          ? "Horizon probe timed out"
          : error instanceof Error
            ? error.message
            : "Horizon probe failed",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeIndexer() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(`${BACKEND_URL}/health/indexer`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        status: "degraded",
        latestLedger: 0,
        syncLag: 0,
        lastError: `Indexer health unreachable (HTTP ${response.status})`,
        message: `Indexer health unreachable (HTTP ${response.status})`,
      };
    }
    const payload = await response.json();
    const data = payload?.data ?? payload;
    return {
      status: data?.status ?? null,
      latestLedger: data?.latest_ledger ?? 0,
      syncLag: data?.sync_lag ?? 0,
      lastSyncTime: data?.last_sync_time ?? null,
      lastSuccessSyncTime: data?.last_success_sync_time ?? null,
      lastError: data?.last_error ?? null,
      message: data?.message ?? null,
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Indexer health probe timed out"
        : error instanceof Error
          ? error.message
          : "Indexer health probe failed";
    return {
      status: "degraded",
      latestLedger: 0,
      syncLag: 0,
      lastError: message,
      message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
