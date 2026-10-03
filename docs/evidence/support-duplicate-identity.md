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
