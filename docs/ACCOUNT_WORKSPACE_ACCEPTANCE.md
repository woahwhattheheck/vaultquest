# Canonical account workspace acceptance

## Reused dependency correction

Account feature source is preserved exactly at
`cb01a810fbacba8333bcbf4af329c3b5555f9065`. This continuation changes only
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, and this evidence document. The
account UI, wallet-chain behavior, production fixture boundary, maintained
tests and earlier bundle evidence are unchanged.

The dependency postimages are reused from
[`08915ce6cf89fcbc238319599d77ff41ff30bc7b`](https://github.com/woahwhattheheck/vaultquest/commit/08915ce6cf89fcbc238319599d77ff41ff30bc7b),
whose [report](https://github.com/woahwhattheheck/vaultquest/blob/08915ce6cf89fcbc238319599d77ff41ff30bc7b/docs/FEE_OBSERVATION_VALIDITY.md#canonical-workspace-installation-follow-through)
explains the compatible Vitest/Vite lines, backend importer correction,
scoped Solana WebSocket dependency and pnpm-generated peer context changes.
There is no new dependency resolution in this continuation. Existing
security floors, all three workspace members and all 15 false build-script
permissions remain in place.

The native job verified complete manifest equality with the donor and
verified both original dependency files against donor preimages at
`13992798d927883579f8c4c4505069b4f34b249b` before installing anything.

| File | Exact Git blob |
| --- | --- |
| `package.json` | `72f6c4c7ca14263cb9e5836368bb399798838d0d` |
| `backend/package.json` | `89c18f365b2200fb693134557b066810a89861a3` |
| `stellar-wallet-connect/package.json` | `453b5d24dc77ae19ee91b9baddb0c82cbe582c40` |
| Tested `pnpm-workspace.yaml` | `24b0f88d509b3fb6d4b62ce0918366697aacaf7f` |
| Tested `pnpm-lock.yaml` | `8c60c191836213cf9024f4c65616fbf59537e756` |

## One actual canonical execution

[Native run 37200266297](https://github.com/woahwhattheheck/vaultquest/actions/runs/37200266297)
completed successfully on October 4, 2026, using isolated controller
[`1b5eb86f91c226d9f5b7e3db894c35a1a8eb7913`](https://github.com/woahwhattheheck/vaultquest/commit/1b5eb86f91c226d9f5b7e3db894c35a1a8eb7913).
Its [workflow](https://github.com/woahwhattheheck/vaultquest/blob/1b5eb86f91c226d9f5b7e3db894c35a1a8eb7913/.github/workflows/vq217-canonical-account.yml)
stays outside the contribution branch. The controller differs from the
feature only by the two dependency files and that workflow.

Actual environment: Node `v22.23.3`, pnpm `10.28.2`, Vitest `3.2.7`, Vite
`6.4.3`, jsdom `25.0.1`.

```sh
pnpm install --frozen-lockfile --reporter=append-only
pnpm exec vitest run lib/account-wallet-state.test.js app/app/account/page.test.jsx --reporter=default --reporter=json --outputFile.json=evidence/account-tests.json
```

The normal frozen installation included all three workspace projects and
completed in 13.9 seconds. No workspace exclusion, alternate runner,
regenerated lock, package script approval or `--ignore-scripts` override
was used. The complete existing selection passed **21/21 tests**: 15 helper
cases and six account component cases. There were zero failed, pending or
todo tests and no snapshot changes. No test was added or modified here.
The runner reported 1.19 seconds; this is one observation, not a performance
comparison.

Selected raw output, with terminal color escapes removed:

```text
Scope: all 3 workspace projects
Lockfile is up to date, resolution step is skipped
Done in 13.9s using pnpm v10.28.2

lib/account-wallet-state.test.js (15 tests) 5ms
app/app/account/page.test.jsx (6 tests) 264ms

Test Files  2 passed (2)
     Tests  21 passed (21)
  Duration  1.19s
```

Dependency SHA-256 checks and clean tracked-tree checks passed after both
installation and execution. [Artifact 11301703591](https://github.com/woahwhattheheck/vaultquest/actions/runs/37200266297/artifacts/11301703591)
retains complete source binding, tracked manifest, dependency patch,
installation/test logs, JSON results, versions and hashes. Its downloaded
ZIP was verified against SHA-256
`e425aa563c6ca8b1b05e597fa38c4299495a90b6516244720c280e007fc3631f`.
The artifact has seven-day retention; the selected output and source
identities above are retained in Git.

## Limits

This is canonical workspace installation plus the existing account helper
and component selection. Earlier production-bundle evidence stays pinned
to its original source and was not rerun. No full application build,
Playwright browser session, live wallet/chain, provider performance,
production deployment or award/payment result is claimed.

The installer still reports ignored package scripts for
`@reown/appkit@1.8.21`, `@stellar/stellar-sdk@14.2.0`, `core-js@3.49.0` and
`keccak@3.0.4` under the retained policy. No approval was granted. The donor
report's other peer warnings and scope limits are not a blanket dependency
compatibility or security certification.
