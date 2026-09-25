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
