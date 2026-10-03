# Support ticket duplicate identity

Operation: VQ218-DUPLICATE-IDENTITY-20261003-DBED. This continues existing PR #218 and issue #117 on top of `2937a07e5f6f6f3788417e50db2cbf2247b1fa8a`, retaining the prior durable-store and draft/retry repairs.

## Failure and correction

The duplicate index used a 32-bit polynomial checksum as the identity of normalized email, category and description. Two different valid descriptions could share that checksum. In an actual `FileSupportTicketStore` run, separate submissions for `Please check reference a~.` and `Please check reference b_.` used different form keys but both received the first receipt. Only one JSONL record existed; the second request had never been persisted.

`duplicateFingerprint` now returns an unambiguous JSON encoding of the complete normalized tuple. Email casing, description casing and whitespace normalization remain the same. This key is internal to the in-memory duplicate index: the JSONL schema, HTTP receipt shape, explicit idempotency-key behavior and duplicate time window do not change. No new dependency or Node-only import is added to the shared helper. The larger key is bounded by the existing validated input limits; it is not persisted or sent to clients.

## Actual execution

The same native store operation changed from one persisted record and `duplicate: true` on the second request to two distinct receipts, two persisted records and `duplicate: false`. Reopening a fresh file-store instance restored both exact descriptions. All input identities and reference strings used here are illustrative.

The existing `lib/support-tickets.test.js` gained two cases: distinct content whose former short keys collide, and case/whitespace-equivalent content that must still deduplicate. The same 19-case selection on the original helper produced 1 failure and 18 passes. The repaired helper produced 19 passes. Both cases use the real file store and filesystem; the distinct-record case reopens the stored receipts. The 17 earlier validation, rate-limit, idempotency, append-failure, concurrent-retry and startup-recovery cases remain present and pass.

Command, from the scoped source checkout with the retained tool runtime on its module path:

```sh
node --max-old-space-size=256 /path/to/retained-runtime/node_modules/vitest/vitest.mjs \
  run lib/support-tickets.test.js --environment node --maxWorkers=1 --reporter=verbose
```

Runtime: Node 24.19.0, Vitest 4.1.9 and Vite 8.1.0. This reused a 47-package tool runtime already available from the preceding Neko repair. It performed no download, dependency installation or manifest/lockfile change. The repository currently declares Vitest `^2.1.8`; that runtime was not available in the retained cache, so this is explicitly an isolated focused run with a newer runner. The full workspace suite, Next application, UI, production build, route smoke checks and deployed intake were not run for this continuation. The prior UI screenshots and validation remain available in `docs/TESTING.md`.

## Duplicate recovery after process restart

The next continuation, on top of `673061be2b476f66e3beacd27dc984d47c107503`, found that JSONL startup restored receipts and explicit form keys but left the normalized duplicate-content index empty. Identical content with a new or missing form key was therefore accepted again immediately after a restart. The complete normalized identity correction above remains intact.

`FileSupportTicketStore` now rebuilds that index while loading persisted tickets. Each entry retains its original `created_at`, so restarting preserves the existing ten-minute window. Later accepted records with the same identity replace earlier entries in file order, matching the live store. No JSONL schema, HTTP shape, explicit-key policy, widget behavior or dependency changes are required.

### Regression results

Seven cases were added to the existing store suite: retries with a new or missing form key just before expiry, normalized casing/whitespace, exact expiry and one millisecond after it, recovery of the latest accepted equivalent receipt, and explicit-key replay after the content window expires. They use the real filesystem and a fresh file-store instance. Against the original loader, the selection produced **4 failures and 22 passes**; the repaired loader produced **26 passes**.

The exact focused command was:

```sh
TMPDIR=/dev/shm/vq218-tmp node --max-old-space-size=192 \
  node_modules/vitest/vitest.mjs run lib/support-tickets.test.js \
  --maxWorkers=1 --minWorkers=1 --reporter=verbose
```

The changed store and test file also pass the repository's `next/core-web-vitals` ESLint configuration, the product-term guard passes, and `git diff --check` is clean. This continuation reused Node 24.19.0, Vitest 2.1.9, Vite 5.4.21, jsdom 25.0.1, ESLint 8.57.1 and `eslint-config-next` 14.2.33. Vitest is now within the declared range; the sponsor's Node 20 matrix was not run.

### Native API evidence

The actual `app/api/support/tickets/route.js` and store were bundled with esbuild 0.21.5, using real Next 14.2.33 `NextRequest` and `NextResponse`. A thin native HTTP adapter delivered curl requests to those handlers. Every request used a separate Node process and the same JSONL file for that phase. Only the clock and receipt randomness were controlled; persistence, validation, normalization and route responses were real. The original and repaired phases used separate files. This exercises the handler across real process exits, rather than a full Next server or a deployed intake.

The first request used `original-form` at `2026-10-03T12:00:00.000Z`. After that process exited, the retry used a new key one second later:

```sh
curl --silent --show-error --max-time 10 \
  -H 'content-type: application/json' \
  --data-binary '{"name":"Ada Lovelace","email":"ada@example.com","category":"wallet","description":"Cannot connect Freighter on mobile Safari.","idempotency_key":"new-form"}' \
  "http://127.0.0.1:$PORT/api/support/tickets"
```

Before the repair, the retry returned **HTTP 201**, and the file contained two records:

```json
{"data":{"id":"VQ-20261003-777777","status":"accepted","created_at":"2026-10-03T12:00:01.000Z","duplicate":false}}
```

After the repair, the retry returned **HTTP 200** with the original receipt, and the file still contained one record:

```json
{"data":{"id":"VQ-20261003-3LLLLL","status":"accepted","created_at":"2026-10-03T12:00:00.000Z","duplicate":true}}
```

Nine native request/read controls passed after the repair:

| Request in a fresh process | HTTP result | JSONL records |
| --- | --- | --- |
| Initial ticket | 201, new receipt | 1 |
| Same content, new key at +1 second | 200, original receipt | 1 |
| Same content, missing key at +2 seconds | 200, original receipt | 1 |
| Equivalent casing/whitespace at +3 seconds | 200, original receipt | 1 |
| GET the persisted original receipt | 200, original receipt metadata | 1 |
| Different description at +5 seconds | 201, separate receipt | 2 |
| Original content at exactly +10 minutes | 201, new receipt | 3 |
| Original content one second after that | 200, latest equivalent receipt | 3 |
| Original explicit key after expiry | 200, original receipt | 3 |

### Limits of this continuation

The unchanged `SupportWidget.test.jsx` suite was included in one run but could not collect because the retained runtime lacks `nanostores`; that command had 26 passing store tests and one suite import failure. A subsequent store-only run exited successfully with all 26 tests. No widget pass is claimed for this continuation. Earlier UI evidence remains in `docs/TESTING.md` and was not replaced.

There was no dependency installation or manifest/lockfile change. The full workspace unit suite, Next production build, full application route smoke tests, Playwright E2E, deployed intake and Node 20 matrix were not run with this partial retained runtime and the shared workspace capacity limit. The native curl evidence above is scoped to the real API handler and durable store.
