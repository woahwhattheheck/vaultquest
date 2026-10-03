# Retry queue ↔ action ledger (#121)

The vault retry queue is backed by the authenticated action ledger. Fixture
rows and `setTimeout` fake retries are not used in production.

## Flow

1. **Load** — `GET /actions?wallet=<connected>` with wallet auth headers.
   Only `pending` and `failed` rows for the connected wallet are shown.
2. **Retry policy** — `lib/retry-queue-policy.js` decides whether an error
   code is retryable (`WALLET_REJECTED`, `RPC_TIMEOUT`, `INSUFFICIENT_FEES`,
   `NETWORK_ERROR`, `WALLET_TIMEOUT`, `TIMEOUT`). Confirmed / submitted /
   reverted / orphaned actions cannot be replayed.
3. **Fresh attempt** — Retry creates a **new** ledger intent (`POST /actions`)
   with a new idempotency key. The payload includes `parent_action_id` and
   `retry_of` linking back to the original. The UI may prompt for a wallet
   signature via an injected `requestSign` hook — **signing is never automatic**.
4. **Cancel** — Pending actions are cancelled with
   `POST /actions/:id/cancel` using `USER_CANCELLED`. Repeating cancel on an
   already-cancelled row is an idempotent success (ledger + client).
5. **Wallet switch** — Changing the connected public key clears local queue
   state and reloads for the new wallet so rows never leak across identities.

## Key modules

| Module | Role |
|--------|------|
| `lib/retry-queue-policy.js` | Error-code policy, row mapping, retry/cancel guards |
| `lib/retry-queue-client.js` | Authenticated ledger HTTP client |
| `components/app/VaultRetryQueue.jsx` | Queue UI |

## Tests

```bash
pnpm exec vitest run \
  lib/retry-queue-policy.test.js \
  lib/retry-queue-client.test.js \
  components/app/VaultRetryQueue.test.jsx
```

Covered scenarios: wallet rejection, RPC timeout, insufficient fees, duplicate
click, late confirmation, cancellation (including idempotent repeat), and
wallet switching.

## Component/client lock ownership

The continuation after `02d0f48acfa80cc9a5d24ae885f3bf03935cc0df` fixes the first Retry and Cancel clicks. Each handler acquired its synchronous component lock and then passed that same set to the client. The client's direct-call guard consequently rejected the current operation as `duplicate_click` before sending a mutation. The existing component tests replaced the client methods, so they did not expose this integration failure.

The handlers now retain their own duplicate-click guard without forwarding the already-held set. The production client and policy are unchanged: a direct caller that supplies an in-flight ID is still rejected. The component still acquires its lock before the authoritative read and releases it in `finally`. Both button flows can now reach the ledger request exactly once.

### Maintained regression coverage

Two cases in `components/app/VaultRetryQueue.test.jsx` use the real `createRetryQueueClient` and policy. Only the ledger transport is controlled. Each test holds the authoritative GET, clicks twice, checks the disabled button and single read, then releases the response. Retry must send one linked-intent POST and render its pending receipt. Cancel must send one cancellation POST and remove the row.

Against the original component, the three-file selection produced **2 failures and 24 passes**. With the two inappropriate context arguments removed, it produced **26 passes**. Existing late-confirmation, direct in-flight retry, terminal-status, wallet-mismatch and idempotent-cancel controls remain present and pass. The changed component/test also pass the repository's Next ESLint configuration, and the product-term and diff checks pass.

This was an isolated retained-runtime run. A bounded search found no `nanostores` package, so a local test configuration supplied an explicit `get`/`set`/`subscribe` wallet-store fixture at that provider boundary. The maintained tests still import the real wallet store; no fixture or alias was added to production or committed test configuration. The component, client and retry/cancel policy were real. The local configuration also deduplicated React across the retained package roots.

Runtime: Node 24.19.0, Vitest 2.1.9, Vite 5.4.21, jsdom 25.0.1, React/ReactDOM 18.3.1, ESLint 8.57.1 and `eslint-config-next` 14.2.33. The retained Testing Library React 16.3.2, Framer Motion 12.42.2 and Lucide 0.378.0 differ from the declared `^14.3.1`, `^11.15.0` and `^0.460.0` ranges respectively. The before/after runs used the same packages. Both runs emitted the same non-fatal jsdom `window.scrollTo` diagnostics and React `act` warnings from existing asynchronous component cases; these were not suppressed.

### Native browser and HTTP evidence

Chromium 154.0.8037.92 ran the original and fixed component bundles separately. Each used the real component, real client and policy, production `styles/globals.css`/Tailwind configuration, and the explicit wallet-store fixture described above. esbuild 0.21.5 built this isolated component; it was not a full Next application build. A local Node HTTP server supplied illustrative ledger records through actual browser fetch requests.

The authoritative GET was held while a second click was attempted. Releasing it produced these results, with no page exceptions in either phase:

| Flow | HTTP reads | HTTP mutations | Visible result |
| --- | --- | --- | --- |
| Original Retry | Queue list + one action GET | None | Original failed row; `retry_blocked:duplicate_click` |
| Fixed Retry | Queue list + one action GET | One `POST /actions` | New linked `act-retry` row, pending |
| Original Cancel | Queue list + one action GET | None | Original pending row; `cancel_blocked:duplicate_click` |
| Fixed Cancel | Queue list + one action GET | One `POST /actions/act-001/cancel` | Cancelled row removed |

The fixed retry sent a fresh idempotency key, retained the wallet header, and linked the original ID in both `parent_action_id` and `retry_of`. Its illustrative action payload was:

```json
{"vault_id":"v1","pool_name":"USDC Yield Pool","amount":"500","token":"USDC","parent_action_id":"act-001","retry_of":"act-001","retry_attempt":1}
```

The fixed cancel retained the wallet header and sent:

```json
{"error_code":"USER_CANCELLED","error_detail":"Action was cancelled by user"}
```

The stable original capture shows the first-click failure:

![Original Retry blocked by its own in-flight lock](images/retry-queue-own-lock-before.png)

The fixed native run verified the pending retry row and removed cancel row as recorded above. Its after capture caught a transient Motion layout frame and is excluded from this PR; it is not presented as a settled layout comparison. The native interaction and HTTP assertions completed successfully before that capture.

### Verification limits

No dependency installation, manifest/lockfile change, upstream merge or signing-provider call was performed. The real `nanostores` integration, ordinary full workspace test configuration, sponsor Node 20 matrix, full Next application/production build, full route smoke/Playwright suite, authenticated backend/Postgres integration and deployed ledger were not exercised by this partial runtime. This continuation verifies the component/client composition defect and preserves the existing backend and wallet contracts.
