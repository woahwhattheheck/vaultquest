from pathlib import Path
import hashlib

p = Path('lib/retry-queue-client.js')
source = p.read_text()
assert hashlib.sha1(b'blob ' + str(len(p.read_bytes())).encode() + b'\0' + p.read_bytes()).hexdigest() == '7a20fcb12cc904e61503ec8e6225ab39e1402e5a'
start = source.index('    async listQueueActions(')
end = source.index('\n    async getAction(', start)
new = '''    async listQueueActions(walletAddress, { status, limit = 50, maxPages = 100 } = {}) {
      if (!walletAddress) return [];
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
        throw new RangeError("maxPages must be an integer between 1 and 1000");
      }
      const params = new URLSearchParams({
        wallet: walletAddress,
        limit: String(limit),
      });
      if (status) params.set("status", status);
      const actions = new Map();
      const seenCursors = new Set();
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const json = await request(`/actions?${params.toString()}`);
        const data = unwrapData(json);
        const items = Array.isArray(data) ? data : data?.items ?? data?.actions;
        if (!Array.isArray(items)) throw new Error("ledger_invalid_page");
        for (const item of items) {
          const row = mapLedgerActionToQueueRow(item);
          // A repeated record may have changed state since the previous page.
          if (row) actions.set(row.id, item);
        }
        const pagination = json?.meta?.pagination;
        if (pagination === undefined) {
          // Legacy array/items/actions responses contain a single page.
          return selectRetryQueueRows([...actions.values()], { walletAddress });
        }
        if (!pagination || typeof pagination.has_more !== "boolean") {
          throw new Error("ledger_invalid_pagination");
        }
        const nextCursor = pagination.next_cursor;
        if (!pagination.has_more) {
          if (nextCursor !== null) throw new Error("ledger_invalid_pagination");
          return selectRetryQueueRows([...actions.values()], { walletAddress });
        }
        if (typeof nextCursor !== "string" || !nextCursor || seenCursors.has(nextCursor)) {
          throw new Error("ledger_invalid_pagination");
        }
        seenCursors.add(nextCursor);
        params.set("cursor", nextCursor);
      }
      // Never turn a truncated read into an apparently empty or complete queue.
      throw new Error("ledger_page_limit_reached");
    },
'''
p.write_text(source[:start] + new + source[end:])
test = Path('lib/retry-queue-client.test.js')
raw = test.read_bytes()
assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest() == '8c2aea061be4d9cb1b2e9bf5370dfd3b756008a2'
with test.open('a') as out:
    out.write('''

describe("retry queue ledger pagination", () => {
  const response = (body, status = 200) => ({
    ok: status === 200,
    status,
    text: async () => JSON.stringify(body),
  });
  const page = (data, next = null) => response({
    data,
    meta: { pagination: { next_cursor: next, has_more: next !== null, limit: 50 } },
  });
  const makeClient = (fetchImpl) => createRetryQueueClient({
    baseUrl: "http://ledger.test",
    fetchImpl,
    getAuthHeaders: async () => ({ "X-Wallet-Address": WALLET }),
  });

  it("finds an older retryable action behind fifty confirmed actions", async () => {
    const older = ledgerAction({ id: "older-failed", error_code: "RPC_TIMEOUT" });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, i) =>
        ledgerAction({ id: `confirmed-${i}`, status: "confirmed", error_code: null })
      ), "older/+=="))
      .mockResolvedValueOnce(page([older]));
    const result = await makeClient(fetchImpl).listQueueActions(WALLET);
    expect(result.map((row) => row.id)).toEqual(["older-failed"]);
    expect(result[0].ledger).toEqual(older);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const query = new URL(fetchImpl.mock.calls[1][0]).searchParams;
    expect(query.get("cursor")).toBe("older/+==");
    expect(query.get("wallet")).toBe(WALLET);
    expect(query.get("limit")).toBe("50");
    expect(fetchImpl.mock.calls.every(([, init]) =>
      init.headers["X-Wallet-Address"] === WALLET && !init.method
    )).toBe(true);
  });

  it("deduplicates records and applies their latest observed state", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([ledgerAction({ id: "changed" }), ledgerAction({ id: "kept" })], "next"))
      .mockResolvedValueOnce(page([
        ledgerAction({ id: "changed", status: "confirmed", error_code: null }),
        ledgerAction({ id: "kept" }),
        ledgerAction({ id: "foreign", wallet_address: WALLET_B }),
        ledgerAction({ id: "cancelled", error_code: USER_CANCELLED }),
      ]));
    const rows = await makeClient(fetchImpl).listQueueActions(WALLET, { status: "failed" });
    expect(rows.map((row) => row.id)).toEqual(["kept"]);
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url).searchParams.get("status") === "failed")).toBe(true);
  });

  it.each(["array", "items", "actions"])("preserves legacy %s responses", async (shape) => {
    const data = [ledgerAction()];
    const body = shape === "array" ? data : { data: { [shape]: data } };
    const fetchImpl = vi.fn().mockResolvedValue(response(body));
    expect((await makeClient(fetchImpl).listQueueActions(WALLET)).map((row) => row.id)).toEqual(["act-001"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed pages rather than returning an empty queue", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: { items: "not-an-array" } }));
    await expect(makeClient(fetchImpl).listQueueActions(WALLET)).rejects.toThrow("ledger_invalid_page");
  });

  it("rejects malformed JSON rather than returning an empty queue", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "not-json" });
    await expect(makeClient(fetchImpl).listQueueActions(WALLET)).rejects.toThrow("ledger_invalid_page");
  });

  it.each([
    { has_more: true, next_cursor: null },
    { has_more: false, next_cursor: "unexpected" },
    { has_more: "yes", next_cursor: "next" },
    null,
  ])("rejects incomplete or contradictory pagination %j", async (pagination) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: [], meta: { pagination } }));
    await expect(makeClient(fetchImpl).listQueueActions(WALLET)).rejects.toThrow("ledger_invalid_pagination");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops a repeated cursor without another request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page([ledgerAction()], "same"));
    await expect(makeClient(fetchImpl).listQueueActions(WALLET)).rejects.toThrow("ledger_invalid_pagination");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports the read bound instead of returning partial rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(page([ledgerAction()], "next"));
    await expect(makeClient(fetchImpl).listQueueActions(WALLET, { maxPages: 1 })).rejects.toThrow("ledger_page_limit_reached");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves a later page's HTTP error without retrying it", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([ledgerAction()], "next"))
      .mockResolvedValueOnce(response({ error: { code: "UNAVAILABLE", message: "ledger unavailable" } }, 503));
    await expect(makeClient(fetchImpl).listQueueActions(WALLET)).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1.5])("rejects invalid read bounds %s before requests", async (maxPages) => {
    const fetchImpl = vi.fn().mockResolvedValue(page([]));
    await expect(makeClient(fetchImpl).listQueueActions(WALLET, { maxPages })).rejects.toThrow(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
''')
