from pathlib import Path

cases = '''  it.each(["submitted", "confirmed", "reverted"] as const)(
    "does not overwrite a %s transition committed before its write",
    async (status) => {
      const created = await svc.createAction(makeIntentInput());
      const settledAt = new Date("2026-01-01T00:00:00.000Z");
      let competingCommit = false;
      // Scope scheduling to a separate real Prisma client extension. Mutating
      // the generated delegate with spies can corrupt its proxy on restoration.
      const racingPrisma = db.prisma.$extends({
        query: {
          actionLedger: {
            async $allOperations({ operation, args, query }) {
              if (!competingCommit && (operation === "update" || operation === "updateMany")) {
                competingCommit = true;
                await db.prisma.actionLedger.update({
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
              return query(args);
            },
          },
        },
      });
      const racingService = new LedgerService(racingPrisma as unknown as typeof db.prisma);
      await expect(racingService.cancelAction(created.id, "USER_CANCELLED", "late cancel"))
        .rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
      expect(competingCommit).toBe(true);
      const row = await svc.getAction(created.id);
      expect(row?.status).toBe(status);
      expect(row?.txHash).toBe("concurrent-tx");
      expect(row?.submittedAt).toEqual(settledAt);
      expect(row?.confirmedAt).toEqual(status === "submitted" ? null : settledAt);
      expect(row?.errorCode).toBe(status === "reverted" ? "REVERTED_ON_CHAIN" : null);
      expect(row?.errorDetail).toBeNull();
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
p = Path('../controller/prepare.py')
s = p.read_text()
a = s.index("CASES = '''")
b = s.index('\n\nOLD =', a)
s = s[:a] + 'CASES = ' + repr(cases) + s[b:]
line = "    replace_once(TEST, 'beforeAll, afterAll, beforeEach }', 'beforeAll, afterAll, beforeEach, vi }')\n"
assert s.count(line) == 1
s = s.replace(line, '')
p.write_text(s)
