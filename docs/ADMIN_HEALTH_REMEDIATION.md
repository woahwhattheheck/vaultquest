# Admin operational health remediation

Runbook for alerts shown on the VaultQuest admin settings console
(`/app/admin/settings`). Live checks are evaluated by
`lib/deployment-provenance.ts` and served from `GET /api/admin/health`.

Related: [`INDEXER_RUNBOOK.md`](./INDEXER_RUNBOOK.md),
[`env-inventory.md`](./env-inventory.md).

---

## Health states

| State | Meaning | Typical cause | Operator action |
|---|---|---|---|
| **Healthy** | Within thresholds | Normal | Continue routine monitoring |
| **Stale** | Soft lag / elevated latency | Indexer behind &lt; hard limit, slow RPC | Monitor; escalate if sustained &gt; 10 minutes |
| **Degraded** | Hard failure or critical drift | RPC down, indexer error, WASM mismatch, critical config drift | Intervene immediately |

---

## 1. RPC health

### Symptoms
- **Stale:** Horizon/Soroban latency ≥ 1500ms.
- **Degraded:** unreachable, HTTP 5xx, timeout, or network passphrase mismatch.

### Diagnose
```bash
curl -s https://horizon-testnet.stellar.org | jq '{network_passphrase, horizon_version}'
curl -s -X POST https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

### Remediate
1. Confirm `NEXT_PUBLIC_HORIZON_URL` / `NEXT_PUBLIC_SOROBAN_RPC_URL` point at the intended network (see `env-inventory.md`).
2. If rate-limited (HTTP 429), switch to a dedicated RPC provider or raise poll interval.
3. If passphrase mismatches, stop using the endpoint — it is the wrong network.

---

## 2. Contract WASM provenance

### Symptoms
- **Degraded:** observed `DEPLOYED_CONTRACT_WASM_HASH` ≠ canonical `EXPECTED_CONTRACT_WASM_HASH`.
- Missing observed hash is also treated as degraded (cannot verify).

### Diagnose
1. Compare the admin panel “Smart contract WASM hash” metadata (`expectedHash` vs `actualHash`).
2. Confirm the drip-pool contract id in `NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID`.
3. Re-derive the release WASM hash from the tagged build artifact.

### Remediate
1. If an upgrade completed, update `EXPECTED_CONTRACT_WASM_HASH` / `DEPLOYED_CONTRACT_WASM_HASH` to the new release hash and redeploy the frontend.
2. If the on-chain hash changed without a governance proposal, pause admin writes and open an incident — treat as possible substitution.
3. Cross-check proxy `last_provenance` on-chain against the published release notes.

---

## 3. Configuration drift

### Symptoms
- **Stale:** non-critical parameters (round duration, deposit caps) differ from canonical provenance.
- **Degraded:** critical parameters (`treasuryFee`, `settlementQuorum`, `emergencyPauseThreshold`) or `contractId` differ.

### Diagnose
1. Open the Config drift panel on `/app/admin/settings`.
2. For each drifted key, compare **expected** (canonical) vs **actual** (runtime / env override).

### Remediate
1. Prefer restoring runtime values to the published release via a governance proposal (`/app/admin/proposals`).
2. If the drift is intentional, update canonical provenance in `lib/deployment-provenance.ts` (and release notes) in the same change set.
3. Use `ADMIN_RUNTIME_PROTOCOL_PARAMETERS` only as a temporary observed-state override for the health probe — not as a permanent source of truth.

---

## 4. Indexer health

Indexer soft/hard lag thresholds follow [`INDEXER_RUNBOOK.md`](./INDEXER_RUNBOOK.md)
(soft ≥ 100 ledgers → stale, hard ≥ 500 or `last_error` → degraded). Use that
runbook for checkpoint inspection, Horizon 429 recovery, and ledger rewind.

```bash
curl -s "${NEXT_PUBLIC_BACKEND_URL:-http://localhost:3001}/health/indexer" | jq .
```

---

## 5. Local verification without live RPC

Unit tests inject probe snapshots into `lib/deployment-provenance.ts` so CI
covers healthy / stale / degraded without network access:

```bash
pnpm vitest run lib/deployment-provenance.test.ts app/app/admin/settings/page.test.jsx
```
