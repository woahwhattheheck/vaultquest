# Chain fee adapters

VaultQuest keeps **Stellar** and **Avalanche** fee / RPC controls on separate
adapters so deposit and withdraw flows cannot mix stroops with wei or Horizon
with C-Chain RPCs.

## Stellar (default for vault UI)

- Adapter: `lib/chain-fee-adapters.js` (`fetchStellarFeeStats`, `buildStellarFeeEstimate`)
- UI: `GasPrioritySelector` with `network="stellar"` (default)
- Fee model: Horizon `/fee_stats` base fee (stroops) + optional Soroban
  simulation resource fee
- Estimates always expose **source ledger** (`last_ledger`) and **freshness**
  (fetch timestamp / stale warning)
- A loaded Stellar sample becomes stale after **60 seconds**, even while the
  selector is idle. The warning and the parent callback's `isStale` and
  `payload.isStale` update together; expiry does not issue another network request.
  Refreshing rates starts a new deadline. The old deadline is cleared on refresh,
  unmount, unsupported state, or a switch to the Avalanche model.
- A sample belongs to the network and Horizon context that requested it. Changing
  the network, custom Horizon source, or supported Stellar context immediately
  removes the previous ledger and Horizon attribution. Until the matching request
  succeeds, the selector exposes the fallback ledger, a null Horizon URL, and
  `isStale: true` in both parent fields. This applies during the first render of
  the changed context, before effects run. A refresh within the same context can
  retain its valid sample while loading; a cancelled earlier request cannot
  replace the current sample. A failed new source cannot inherit another source's
  Horizon URL.
- Explorers: Stellar Expert only — never EVM explorers on this path
- Custom RPC: Horizon overrides save independently via the Stellar tab in
  `CustomRpcModal`

## Avalanche (independently routed product)

- Avalanche C-Chain / Fuji RPC fields and EVM gas math remain available when
  `network="avalanche"` is passed explicitly, or via the Avalanche tab in
  custom RPC settings.
- Stellar deposit/withdraw flows must not depend on Avalanche RPC, chain ID,
  or wei controls.

## Acceptance checklist (#123)

- [x] Stellar deposit/withdraw flows contain no EVM explorer, wei, chain ID, or Avalanche RPC dependency
- [x] Fee estimates state source ledger and freshness
- [x] Tests cover Stellar testnet/mainnet, stale fee data, custom Horizon, unsupported network

## Idle fee expiry verification

The existing fee suite includes exact 59,999 / 60,000 ms checks for testnet and
mainnet, refreshing before and after expiry, switching to unsupported/Avalanche,
and unmount cleanup. These run the real selector and fee adapter against a
controlled Horizon response.

The screenshots below show the actual component with the project stylesheet in
Chromium 154 after at least 60 seconds without interaction or a second fetch.
The response is fixed at ledger `5432100` and base fee `120` stroops. This is an
isolated component fixture, not a full application or live Horizon test.

| Before the expiry fix | After the expiry fix |
| --- | --- |
| ![An expired Stellar sample still marked Live rate, with isStale false](images/stellar-fee-expiry-before.png) | ![The same elapsed sample marked Stale data, with a warning and isStale true](images/stellar-fee-expiry-after.png) |

## Network and Horizon context verification

The context continuation preserves the expiry behavior above and adds nine cases
to the existing selector suite. They cover both network-switch directions,
custom Horizon replacement and failure, returning to an earlier context,
unsupported-state reactivation, a refresh within the same context, and delayed
success or failure from a cancelled earlier request. The network-switch cases
also inspect the first committed render before passive effects and every parent
callback while the replacement request is held.

```bash
npm test -- \
  lib/chain-fee-adapters.test.js \
  components/app/GasPrioritySelector.test.jsx \
  components/app/CustomRpcModal.test.jsx \
  lib/customRpc.test.js \
  --maxWorkers=1 --minWorkers=1
```

The four-file selection passes **54/54** checks. Substituting the exact preceding
component from `221177edc1e6ae890649c3a0a4c883cfc86945c0`, with the same final tests,
produces **6 failures / 48 passes**: all six failures concern context attribution;
the existing 45 checks and the three new refresh/cancellation controls pass.
The changed JSX files pass the repository's Next 14 / ESLint 8 configuration.
The product-term guard passes on the materialized sparse checkout, and
`git diff --check` passes. No dependency or lockfile files changed.

The browser observation uses the actual selector, chain adapter, custom RPC
resolver, wagmi chain metadata, and project stylesheet in **Chromium
153.0.8010.0**. Parent prop controls are an isolated fixture; Horizon responses
are intercepted and held. Each version makes seven fee requests and records
eleven snapshots, with no page errors or unexpected external requests.

| Observed transition | Preceding component | Corrected component |
| --- | --- | --- |
| Testnet to mainnet, new request pending | Mainnet callback retains testnet ledger `111111` and testnet Horizon; both stale flags are false | Fallback ledger, null Horizon, and both stale flags true until mainnet ledger `222222` arrives |
| Custom Horizon changes, new request pending | Previous source's ledger and Horizon remain attributed as fresh | Previous attribution is cleared immediately |
| New custom Horizon returns HTTP 503 | Fallback still carries the preceding Horizon URL | Fallback has no Horizon attribution |
| Same-context refresh and cancelled earlier response | Valid sample survives the refresh wait; late cancelled response is ignored | Both controls remain unchanged |

| Before the context fix, mainnet request pending | After the context fix, same request pending |
| --- | --- |
| ![Mainnet parent callback retaining testnet ledger and Horizon with stale false](images/stellar-fee-context-before.png) | ![Mainnet parent callback using fallback ledger, no Horizon, and stale true](images/stellar-fee-context-after.png) |

Validation used retained Node 24.19.0, Vitest 2.1.9, React / React DOM 18.3.1,
jsdom 25.0.1, wagmi 2.14.6, Vite 5.4.21, and esbuild 0.21.5. Testing Library React
16.3.2 and lucide-react 0.378.0 (tests) / 0.363.0 (browser) differ from the declared
Testing Library ^14.3.1 / lucide-react ^0.460.0 ranges. These focused tests and
the isolated browser fixture do not establish a complete lockfile installation,
full application build or route E2E, the Node 20 matrix, or live Horizon behavior.
