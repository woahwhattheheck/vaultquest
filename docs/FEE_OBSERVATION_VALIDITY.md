# Stellar fee observation validity

The provider boundary accepts positive safe integers supplied as JSON numbers
or decimal digit strings for both `last_ledger_base_fee` and `last_ledger`.
Malformed, missing, fractional, boolean, container or unsafe-integer values
raise an error instead of being presented as observed pricing or provenance.
The selector's existing failure path supplies the same 100-stroop fallback
with no source ledger and both stale indicators set. HTTP failure handling,
priority multipliers, simulation fees and the existing network/expiry fixes
are unchanged. This does not prove that a provider's well-formed value is true.

The fee payload and visible XLM amount now use seven decimal places, matching
the existing 10,000,000-stroops-per-XLM conversion. For example, 101 stroops is
shown as `0.0000101 XLM`, not rounded to `0.000010 XLM`. Fee selection, account
balance checks, USD-rate assumptions and Avalanche rendering are unchanged.

## Executed evidence and revision boundaries

Original source: `bc3ce9c1e33d3f2692b34a0cdcef42262e866dd2`.
[Original and initial candidate run](https://github.com/woahwhattheheck/vaultquest/actions/runs/37194233211):
34 passed / 33 failed before the repair; 65 passed / 2 failed afterward. All
33 new defect cases were repaired. The two remaining failures expected the
old six-decimal display strings for 5000 and 250 stroops.

This contribution updates those exact expectations to `0.0005000 XLM` and
`0.0000250 XLM`. Their numeric fee assertions and the equality checks remain;
no test is removed, skipped, or weakened. The production files and new
regression file are byte-identical to the first executed candidate.

[Final focused candidate run](https://github.com/woahwhattheheck/vaultquest/actions/runs/37194493752): 67 passed,
0 failed, 0 pending. The baseline is reused, not rerun in the final job.
Node `v24.21.0`; isolated Vitest 3.2.6 / Vite 6.4.3 / jsdom 25.0.1.
Other frontend runtime dependencies retain their locked versions.

```text
pnpm exec vitest run lib/chain-fee-adapters.test.js components/app/GasPrioritySelector.test.jsx lib/chain-fee-observation.test.jsx
```

Controlled HTTP responses exercise the actual adapter. Component checks mount
the actual selector and inspect its visible amount, freshness and parent
callback. No live Horizon or transaction is used.

## Environment limits

Three earlier setup attempts did not execute tests: the full workspace's
backend lockfile disagreed with its manifest; the frontend's retained
Vitest/Vite pairing failed before collection; and the isolated runner setup
initially assumed Vite was a root dependency instead of transitive-only.
Frontend installation temporarily excludes the unrelated backend and restores
the workspace file before source checks. Vitest and Vite links are redirected
only in untracked node_modules to the isolated compatible runner.

No product dependency manifest, lockfile or workspace file is changed. This
does not claim that canonical full-workspace installation is repaired. Raw
reports, source patch and sources are in the runs' artifacts; the isolated
runner lock is retained too. The first executed archive, artifact 11299379959,
has SHA-256 `cb6b570a0c23b55305053fcb9afd5b1dfb7aea1362508c1703c173e8d9e2ee69`.
Validation workflows remain outside this contribution branch. No application
build, full browser-wallet session, live-chain, performance, award or payout
result is claimed.
