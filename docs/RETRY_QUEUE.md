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
