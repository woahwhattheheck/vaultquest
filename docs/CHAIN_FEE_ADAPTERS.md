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
