import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRetryQueueClient } from "./retry-queue-client.js";
import { USER_CANCELLED } from "./retry-queue-policy.js";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";

function ledgerAction(overrides = {}) {
  return {
    id: "act-001",
    wallet_address: WALLET,
    action_type: "deposit",
    action_payload: {
      vault_id: "v1",
      pool_name: "USDC Yield Pool",
      amount: "500",
      token: "USDC",
    },
    status: "failed",
    error_code: "WALLET_REJECTED",
    error_detail: "rejected",
    retry_count: 0,
    created_at: "2026-09-24T12:00:00.000Z",
    ...overrides,
  };
}

describe("createRetryQueueClient", () => {
  let fetchImpl;
  let client;

  beforeEach(() => {
    fetchImpl = vi.fn();
    client = createRetryQueueClient({
      baseUrl: "http://ledger.test",
      fetchImpl,
      getAuthHeaders: async () => ({ "X-Wallet-Address": WALLET }),
    });
  });

  it("loads queue rows from the authenticated ledger", async () => {
    fetchImpl.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            ledgerAction(),
            ledgerAction({
              id: "act-002",
              status: "confirmed",
              error_code: null,
            }),
          ],
        }),
    });

    const rows = await client.listQueueActions(WALLET);
    expect(fetchImpl).toHaveBeenCalled();
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/actions?");
    expect(url).toContain(`wallet=${WALLET}`);
    expect(rows.map((r) => r.id)).toEqual(["act-001"]);
    expect(rows[0].ledger.id).toBe("act-001");
  });

  it("creates a fresh linked attempt and optionally requests a signature", async () => {
    const created = ledgerAction({
      id: "act-retry",
      status: "pending",
      error_code: null,
      action_payload: {
        vault_id: "v1",
        parent_action_id: "act-001",
        retry_of: "act-001",
        amount: "500",
        token: "USDC",
      },
    });
    fetchImpl
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ data: ledgerAction() }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ data: created }),
      });

    const requestSign = vi.fn(async () => ({ signed: false }));
    const original = {
      id: "act-001",
      type: "deposit",
      status: "failed",
      errorCode: "WALLET_REJECTED",
      walletAddress: WALLET,
      retryCount: 0,
      payload: { vault_id: "v1", amount: "500", token: "USDC" },
      ledger: ledgerAction(),
    };

    const result = await client.createRetryAttempt(original, {
      walletAddress: WALLET,
      requestSign,
      idempotencyKey: "22222222-2222-2222-2222-222222222222",
    });

    expect(requestSign).toHaveBeenCalledTimes(1);
    expect(result.parentActionId).toBe("act-001");
    expect(result.action.id).toBe("act-retry");

    expect(fetchImpl.mock.calls[0][0]).toContain("/actions/act-001");
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toBe(
      "22222222-2222-2222-2222-222222222222"
    );
    const body = JSON.parse(init.body);
    expect(body.action_payload.parent_action_id).toBe("act-001");
  });

  it("blocks retry after late confirmation without writing", async () => {
    const original = {
      id: "act-001",
      type: "deposit",
      status: "failed",
      errorCode: "RPC_TIMEOUT",
      walletAddress: WALLET,
      retryCount: 0,
      payload: {},
      ledger: ledgerAction({ error_code: "RPC_TIMEOUT" }),
    };
    await expect(
      client.createRetryAttempt(original, {
        walletAddress: WALLET,
        freshAction: {
          ...original,
          status: "confirmed",
          errorCode: null,
        },
      })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/already_confirmed|not_replayable_status/),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [null, "invalid_parent_action"],
    [ledgerAction({ id: "another-action" }), "invalid_parent_action"],
    [ledgerAction({ wallet_address: null }), "wallet_mismatch"],
    [ledgerAction({ wallet_address: WALLET_B }), "wallet_mismatch"],
    [ledgerAction({ status: "confirmed", error_code: null }), "not_replayable_status"],
  ])("rejects an invalid or terminal fresh parent before writing/signing", async (data, code) => {
    fetchImpl.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ data }) });
    const requestSign = vi.fn();
    await expect(client.createRetryAttempt({
      id: "act-001", walletAddress: WALLET, status: "failed", errorCode: "RPC_TIMEOUT",
      type: "deposit", payload: {}, ledger: ledgerAction(),
    }, { requestSign })).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined();
    expect(requestSign).not.toHaveBeenCalled();
  });

  it("does not use the displayed row when the fresh ledger read fails", async () => {
    fetchImpl.mockResolvedValue({
      ok: false, status: 503,
      text: async () => JSON.stringify({ error: { code: "LEDGER_UNAVAILABLE", message: "unavailable" } }),
    });
    const requestSign = vi.fn();
    await expect(client.createRetryAttempt({
      id: "act-001", walletAddress: WALLET, status: "failed", errorCode: "RPC_TIMEOUT",
      type: "deposit", payload: {}, ledger: ledgerAction(),
    }, { requestSign })).rejects.toMatchObject({ code: "LEDGER_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined();
    expect(requestSign).not.toHaveBeenCalled();
  });

  it("reuses a matching fresh preflight and builds from its authoritative payload", async () => {
    fetchImpl.mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ data: ledgerAction({ id: "act-retry", status: "pending" }) }),
    });
    const original = {
      id: "act-001", walletAddress: WALLET, status: "failed", errorCode: "RPC_TIMEOUT",
      type: "deposit", payload: { amount: "stale" }, ledger: ledgerAction(),
    };
    await client.createRetryAttempt(original, {
      freshAction: { ...original, payload: { vault_id: "v1", amount: "500", token: "USDC" } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).action_payload.amount).toBe("500");
  });

  it("cancels pending actions and treats repeat cancel as idempotent", async () => {
    fetchImpl
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            data: ledgerAction({ status: "pending", error_code: null }),
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            data: ledgerAction({
              status: "failed",
              error_code: USER_CANCELLED,
              error_detail: "Action was cancelled by user",
            }),
          }),
      });

    const row = {
      id: "act-001",
      status: "pending",
      walletAddress: WALLET,
      errorCode: null,
      ledger: ledgerAction({ status: "pending", error_code: null }),
    };

    const first = await client.cancelAction(row, { walletAddress: WALLET });
    expect(first.idempotent).toBe(false);
    expect(first.action.errorCode).toBe(USER_CANCELLED);

    fetchImpl.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: ledgerAction({
            status: "failed",
            error_code: USER_CANCELLED,
          }),
        }),
    });

    const second = await client.cancelAction(row, { walletAddress: WALLET });
    expect(second.idempotent).toBe(true);
  });

  it("rejects cancel when wallet switched", async () => {
    const row = {
      id: "act-001",
      status: "pending",
      walletAddress: WALLET,
      errorCode: null,
      ledger: ledgerAction({ status: "pending", error_code: null }),
    };
    await expect(
      client.cancelAction(row, {
        walletAddress: WALLET,
        freshAction: { ...row, walletAddress: WALLET_B },
      })
    ).rejects.toMatchObject({ code: "wallet_mismatch" });
  });
});


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
