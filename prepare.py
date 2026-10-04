import json
from pathlib import Path
import subprocess
import sys

BASE = '093bec9f6e09e4d40e0a55035d2941b5fe42edee'
SCHEMA_DONOR = 'dd369b16f589599c29cf21aacf49db441b1394f0'
SOURCE = Path('backend/src/services/ledger.ts')
TEST = Path('backend/tests/ledger.spec.ts')
SCHEMA = Path('backend/prisma/schema.prisma')

def git(*args):
    return subprocess.check_output(['git', *args]).decode()

def replace_once(path, before, after):
    text = path.read_text()
    if text.count(before) != 1:
        raise SystemExit(f'exact source preimage mismatch: {path}')
    path.write_text(text.replace(before, after, 1))

CASES = '''  it.each(["submitted", "confirmed", "reverted"] as const)(
    "does not overwrite a %s transition committed before its write",
    async (status) => {
      const created = await svc.createAction(makeIntentInput());
      // Keep every database operation real. Intercept only the scheduling point
      // immediately before either implementation's cancellation write.
      const update = db.prisma.actionLedger.update.bind(db.prisma.actionLedger);
      const updateMany = db.prisma.actionLedger.updateMany.bind(db.prisma.actionLedger);
      let competingCommit = false;
      const settledAt = new Date("2026-01-01T00:00:00.000Z");
      async function commitCompetitor() {
        if (competingCommit) return;
        competingCommit = true;
        await update({
          where: { id: created.id },
          data: {
            status,
            txHash: "concurrent-tx",
            submittedAt: settledAt,
            confirmedAt: status === "submitted" ? null : settledAt,
            errorCode: status === "reverted" ? "REVERTED_ON_CHAIN" : null,
          },
        });
      }
      const one = vi.spyOn(db.prisma.actionLedger, "update").mockImplementation(async (args) => {
        await commitCompetitor();
        return update(args);
      });
      const many = vi.spyOn(db.prisma.actionLedger, "updateMany").mockImplementation(async (args) => {
        await commitCompetitor();
        return updateMany(args);
      });
      try {
        await expect(svc.cancelAction(created.id, "USER_CANCELLED", "late cancel"))
          .rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
        expect(competingCommit).toBe(true);
        const row = await svc.getAction(created.id);
        expect(row?.status).toBe(status);
        expect(row?.txHash).toBe("concurrent-tx");
        expect(row?.submittedAt).toEqual(settledAt);
        expect(row?.confirmedAt).toEqual(status === "submitted" ? null : settledAt);
        expect(row?.errorCode).toBe(status === "reverted" ? "REVERTED_ON_CHAIN" : null);
        expect(row?.errorDetail).toBeNull();
      } finally {
        one.mockRestore();
        many.mockRestore();
      }
    },
  );

  it("keeps the first cancellation reason when two callers cancel concurrently", async () => {
    const created = await svc.createAction(makeIntentInput());
    const results = await Promise.all([
      svc.cancelAction(created.id, "USER_CANCELLED", "first request"),
      svc.cancelAction(created.id, "CANCELLED_BY_USER", "second request"),
    ]);
    const stored = await svc.getAction(created.id);
    expect(stored?.status).toBe("failed");
    for (const result of results) {
      expect(result.errorCode).toBe(stored?.errorCode);
      expect(result.errorDetail).toBe(stored?.errorDetail);
    }
  });

  it("returns NOT_FOUND for a missing cancellation target", async () => {
    await expect(svc.cancelAction("11111111-1111-1111-1111-111111111111", "USER_CANCELLED"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

'''

OLD = '''    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    if (!row) throw AppError.notFound(`action ${id} not found`);

    const CANCEL_CODES = new Set(["USER_CANCELLED", "CANCELLED_BY_USER"]);

    // Idempotent cancel: repeating cancel on an already-cancelled row is a no-op success (#121).
    if (row.status === "failed" && row.errorCode && CANCEL_CODES.has(row.errorCode)) {
      return row as unknown as ActionRecord;
    }

    if (row.status !== "pending") {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `cannot cancel action in status ${row.status}`
      );
    }

    const updated = await this.prisma.actionLedger.update({
      where: { id },
      data: { status: "failed", errorCode, errorDetail: errorDetail ?? null }
    });
    return updated as unknown as ActionRecord;'''

NEW = '''    // Check and mutate in the same database statement. A prior read can become
    // stale while submission or reconciliation commits a terminal state (#121).
    const changed = await this.prisma.actionLedger.updateMany({
      where: { id, status: "pending" },
      data: { status: "failed", errorCode, errorDetail: errorDetail ?? null }
    });
    const row = await this.prisma.actionLedger.findUnique({ where: { id } });
    if (!row) throw AppError.notFound(`action ${id} not found`);

    const CANCEL_CODES = new Set(["USER_CANCELLED", "CANCELLED_BY_USER"]);
    // A competing cancellation retains the first caller's reason and detail.
    if (changed.count === 1 ||
        (row.status === "failed" && row.errorCode && CANCEL_CODES.has(row.errorCode))) {
      return row as unknown as ActionRecord;
    }

    throw AppError.conflict(
      ERROR_CODES.ILLEGAL_TRANSITION,
      `cannot cancel action in status ${row.status}`
    );'''

phase = sys.argv[1]
if git('rev-parse', 'HEAD').strip() != BASE:
    raise SystemExit('subject head changed')
if phase == 'prepare':
    assert git('hash-object', str(SCHEMA)).strip() == 'ba0b424bf07819caac48290bcd7934ec2f59eaea'
    assert git('hash-object', str(TEST)).strip() == 'd89f39560141cd447f464681c63447b44813fd2f'
    original = SCHEMA.read_text()
    donor = git('show', f'{SCHEMA_DONOR}:{SCHEMA}')
    marker = '/// Distributed lease for scheduled jobs (#93).'
    assert donor.count(marker) == 1
    fixed = donor.split(marker)[0].rstrip() + '\n'
    assert original.split('<<<<<<< HEAD')[0] == fixed.split('model UserProfile')[0]
    SCHEMA.write_text(fixed)
    replace_once(TEST, 'beforeAll, afterAll, beforeEach }', 'beforeAll, afterAll, beforeEach, vi }')
    insertion = '  it("rejects cancel on submitted", async () => {'
    replace_once(TEST, insertion, CASES + insertion)
    # The retained npm lock predates two unrelated manifest additions. Use its
    # exact graph for this isolated ledger check, then restore the product manifest.
    manifest = Path('backend/package.json')
    Path('../original-package.json').write_bytes(manifest.read_bytes())
    locked = json.loads(Path('backend/package-lock.json').read_text())['packages']['']
    manifest.write_text(json.dumps({**locked, 'type': 'module', 'private': True}, indent=2) + '\n')
elif phase == 'patch':
    replace_once(SOURCE, OLD, NEW)
elif phase == 'finish':
    evidence = Path('../evidence')
    before = json.loads((evidence / 'before.json').read_text())
    after = json.loads((evidence / 'after.json').read_text())
    def selected(report):
        return [a for suite in report['testResults'] for a in suite['assertionResults']
                if a['status'] != 'pending']
    b, a = selected(before), selected(after)
    assert (evidence / 'before.exit').read_text().strip() == '1'
    assert (evidence / 'after.exit').read_text().strip() == '0'
    assert len(b) == len(a) == 8, (len(b), len(a))
    races = [case for case in b if 'does not overwrite a ' in case['fullName']]
    assert len(races) == 3 and all(case['status'] == 'failed' for case in races)
    assert all(case['status'] == 'passed' for case in a)
    Path('backend/package.json').write_bytes(Path('../original-package.json').read_bytes())
    allowed = {str(SOURCE), str(TEST), str(SCHEMA)}
    changed = set(git('diff', '--name-only').splitlines())
    assert changed == allowed, changed
    hashes = {str(path): git('hash-object', str(path)).strip() for path in [SOURCE, TEST, SCHEMA]}
    receipt = {'base': BASE, 'schema_donor': SCHEMA_DONOR, 'hashes': hashes,
               'before_passed': sum(x['status'] == 'passed' for x in b),
               'before_failed': sum(x['status'] == 'failed' for x in b),
               'after_passed': len(a), 'after_failed': 0,
               'command': "node node_modules/vitest/vitest.mjs run tests/ledger.spec.ts -t 'LedgerService.cancelAction' --maxWorkers=1 --minWorkers=1",
               'runtime': {'node': git('--version').strip(), 'postgres': 'postgres:16-alpine'},
               'limits': 'Real PostgreSQL via existing Testcontainers helper; competing writes scheduled at the Prisma call boundary. Not a live-chain, full-suite or whole-package installation claim.'}
    receipt['runtime']['node'] = subprocess.check_output(['node', '--version']).decode().strip()
    (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    doc = '# Atomic action cancellation\n\n'
    doc += 'Cancellation updates only a row whose status is still `pending` in the same database statement. Submission, confirmation and reversion that commit first are preserved; the losing cancellation returns `ILLEGAL_TRANSITION`. Repeated user cancellations return the stored first reason without overwriting it. Missing targets retain `NOT_FOUND`.\n\n'
    doc += 'The inherited unresolved Prisma schema was repaired using the existing #220 privacy-preserving correction, without importing its JobLease model or worker changes. The identical corrected schema was used before and after the cancellation repair.\n\n'
    doc += '## Focused PostgreSQL execution\n\n```json\n' + json.dumps(receipt, indent=2) + '\n```\n\n'
    doc += 'The test runtime was installed from the committed npm lock using its recorded root manifest. The product manifest was restored unchanged; its unrelated SendGrid/Stellar additions are not covered by this runtime. No dependency file changes, full application build, external provider calls or live transaction execution are claimed. The existing cancellation tests and five additional cases are in `backend/tests/ledger.spec.ts`; other describes were not executed.\n'
    Path('docs/LEDGER_CANCELLATION.md').write_text(doc)
else:
    raise SystemExit('unknown phase')
