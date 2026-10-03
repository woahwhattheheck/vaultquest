import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import VaultRetryQueue from "./VaultRetryQueue";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { createRetryQueueClient } from "@/lib/retry-queue-client";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";

function makeRow(overrides = {}) {
  return {
    id: "act-001",
    type: "deposit",
    pool: "USDC Yield Pool",
    amount: "500",
    token: "USDC",
    status: "failed",
    errorCode: "WALLET_REJECTED",
    errorDetail: "User rejected",
    createdAt: new Date().toISOString(),
    retryCount: 0,
    walletAddress: WALLET,
    parentActionId: null,
    payload: { vault_id: "v1", amount: "500", token: "USDC" },
    ledger: { id: "act-001", status: "failed" },
    ...overrides,
  };
}

describe("VaultRetryQueue", () => {
  beforeEach(() => {
    connectedPublicKey.set("");
  });

  it("renders nothing without a connected wallet", () => {
    const client = {
      listQueueActions: vi.fn(),
    };
    const { container } = render(<VaultRetryQueue client={client} />);
    expect(container).toBeEmptyDOMElement();
    expect(client.listQueueActions).not.toHaveBeenCalled();
  });

  it("loads ledger-backed rows for the connected wallet", async () => {
    connectedPublicKey.set(WALLET);
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([makeRow()]),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Pool/)).toBeInTheDocument();
    });
    expect(client.listQueueActions).toHaveBeenCalledWith(WALLET);
    expect(screen.getByRole("button", { name: /Retry deposit/i })).toBeInTheDocument();
  });

  it("creates a fresh linked attempt on retry without auto-signing", async () => {
    connectedPublicKey.set(WALLET);
    const created = makeRow({
      id: "act-retry",
      status: "pending",
      errorCode: null,
      parentActionId: "act-001",
    });
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([makeRow()]),
      getAction: vi.fn().mockResolvedValue(makeRow()),
      createRetryAttempt: vi.fn().mockResolvedValue({
        action: created,
        signature: null,
        parentActionId: "act-001",
      }),
      cancelAction: vi.fn(),
    };
    const requestSign = vi.fn();
    render(<VaultRetryQueue client={client} requestSign={requestSign} />);
    await waitFor(() => screen.getByRole("button", { name: /Retry deposit/i }));
    fireEvent.click(screen.getByRole("button", { name: /Retry deposit/i }));
    await waitFor(() => expect(client.createRetryAttempt).toHaveBeenCalled());
    const [, ctx] = client.createRetryAttempt.mock.calls[0];
    expect(ctx.requestSign).toBe(requestSign);
    expect(ctx.walletAddress).toBe(WALLET);
  });

  it("cancels a pending action via the ledger client", async () => {
    connectedPublicKey.set(WALLET);
    const pending = makeRow({
      status: "pending",
      errorCode: null,
      errorDetail: null,
    });
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([pending]),
      cancelAction: vi.fn().mockResolvedValue({
        action: { ...pending, status: "failed", errorCode: "USER_CANCELLED" },
        idempotent: false,
      }),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => screen.getByRole("button", { name: /Cancel pending action/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel pending action/i }));
    await waitFor(() => expect(client.cancelAction).toHaveBeenCalled());
  });

  it("reloads for the new wallet when the connected key switches", async () => {
    connectedPublicKey.set(WALLET);
    const client = {
      listQueueActions: vi
        .fn()
        .mockResolvedValueOnce([makeRow()])
        .mockResolvedValueOnce([
          makeRow({ id: "act-b", walletAddress: WALLET_B, pool: "Other Pool" }),
        ]),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => screen.getByText(/USDC Yield Pool/));
    connectedPublicKey.set(WALLET_B);
    await waitFor(() => {
      expect(client.listQueueActions).toHaveBeenCalledWith(WALLET_B);
    });
  });

  it("ignores duplicate retry clicks while an attempt is in flight", async () => {
    connectedPublicKey.set(WALLET);
    let resolveRetry;
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([makeRow()]),
      getAction: vi.fn().mockResolvedValue(makeRow()),
      createRetryAttempt: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          })
      ),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => screen.getByRole("button", { name: /Retry deposit/i }));
    const btn = screen.getByRole("button", { name: /Retry deposit/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(client.createRetryAttempt).toHaveBeenCalledTimes(1));
    // Button is disabled while busy so further clicks are a no-op.
    expect(screen.getByRole("button", { name: /Retry deposit/i })).toBeDisabled();
    resolveRetry({
      action: makeRow({ id: "act-retry", status: "pending", errorCode: null }),
      signature: null,
      parentActionId: "act-001",
    });
  });

  it.each(["retry", "cancel"])(
    "allows the first %s through the real client while blocking duplicate clicks",
    async (operation) => {
      const original = {
        id: "act-001",
        wallet_address: WALLET,
        action_type: "deposit",
        action_payload: { vault_id: "v1", amount: "500", token: "USDC" },
        status: operation === "retry" ? "failed" : "pending",
        error_code: operation === "retry" ? "WALLET_REJECTED" : null,
        retry_count: 0,
        created_at: "2026-09-24T12:00:00.000Z",
      };
      let releaseFresh;
      const freshReady = new Promise((resolve) => {
        releaseFresh = resolve;
      });
      // Exercise the production client and policy; only the ledger transport
      // is controlled so a second click can race the authoritative read.
      const fetchImpl = vi.fn(async (url, init = {}) => {
        const requestPath = new URL(url).pathname;
        let data;
        if (init.method === "POST") {
          data = operation === "retry"
            ? {
                ...original,
                id: "act-retry",
                status: "pending",
                error_code: null,
                action_payload: JSON.parse(init.body).action_payload,
              }
            : { ...original, status: "failed", error_code: "USER_CANCELLED" };
        } else if (requestPath === "/actions/act-001") {
          await freshReady;
          data = original;
        } else {
          data = [original];
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = createRetryQueueClient({
        baseUrl: "http://ledger.test",
        fetchImpl,
        getAuthHeaders: () => ({ "X-Wallet-Address": WALLET }),
      });
      render(<VaultRetryQueue walletAddress={WALLET} client={client} />);
      const button = await screen.findByRole("button", {
        name: operation === "retry" ? "Retry deposit" : "Cancel pending action",
      });

      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => {
        expect(fetchImpl.mock.calls.filter(([url]) =>
          new URL(url).pathname === "/actions/act-001",
        )).toHaveLength(1);
      });
      expect(button).toBeDisabled();
      releaseFresh();

      const writes = () => fetchImpl.mock.calls.filter(([, init]) => init.method === "POST");
      await waitFor(() => expect(writes()).toHaveLength(1));
      const [url, init] = writes()[0];
      expect(init.headers["X-Wallet-Address"]).toBe(WALLET);
      if (operation === "retry") {
        expect(new URL(url).pathname).toBe("/actions");
        expect(JSON.parse(init.body).action_payload).toMatchObject({
          parent_action_id: original.id,
          retry_of: original.id,
        });
        await waitFor(() => expect(document.querySelector('[data-action-id="act-retry"]')).not.toBeNull());
      } else {
        expect(new URL(url).pathname).toBe("/actions/act-001/cancel");
        expect(JSON.parse(init.body).error_code).toBe("USER_CANCELLED");
        await waitFor(() => expect(screen.queryByRole("region", { name: "Transaction retry queue" })).toBeNull());
      }
    },
  );
});
