import { describe, it, expect } from "vitest";
import {
  validateTicketInput,
  mintReceiptId,
  duplicateFingerprint,
  MAX_DESCRIPTION_CHARS,
} from "./support-tickets.js";
import {
  MemorySupportTicketStore,
  clientRateKey,
} from "./support-ticket-store.js";

const base = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  category: "wallet",
  description: "Cannot connect Freighter on mobile Safari.",
};

describe("validateTicketInput", () => {
  it("accepts a well-formed ticket and normalizes email", () => {
    const result = validateTicketInput({ ...base, email: "Ada@Example.COM" });
    expect(result.ok).toBe(true);
    expect(result.ticket.email).toBe("ada@example.com");
    expect(result.ticket.wallet_address).toBeNull();
  });

  it("binds a stellar wallet hint without treating it as proof", () => {
    const wallet = "G".padEnd(56, "A");
    const result = validateTicketInput({ ...base, wallet_address: wallet });
    expect(result.ok).toBe(true);
    expect(result.ticket.wallet_address).toBe(wallet);
  });

  it("rejects oversized content", () => {
    const result = validateTicketInput({
      ...base,
      description: "x".repeat(MAX_DESCRIPTION_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.description).toMatch(/at most/);
  });

  it("rejects anonymous empty payloads", () => {
    const result = validateTicketInput({});
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.name).toBeTruthy();
    expect(result.fieldErrors.email).toBeTruthy();
    expect(result.fieldErrors.description).toBeTruthy();
  });
});

describe("mintReceiptId", () => {
  it("returns a stable-looking receipt id", () => {
    const id = mintReceiptId({ now: () => Date.parse("2026-09-24T12:00:00Z"), random: () => 0.5 });
    expect(id).toMatch(/^VQ-20260924-[0-9A-Z]{6}$/);
  });
});

describe("MemorySupportTicketStore", () => {
  it("persists a ticket and returns a receipt id", async () => {
    const store = new MemorySupportTicketStore({
      now: () => 1_000_000,
      random: () => 0.1,
    });
    const { ticket, duplicate } = await store.create(base, { clientKey: "a" });
    expect(duplicate).toBe(false);
    expect(ticket.id).toMatch(/^VQ-/);
    expect(ticket.status).toBe("accepted");
    expect(await store.get(ticket.id)).toEqual(ticket);
  });

  it("returns the same ticket for an idempotency key", async () => {
    const store = new MemorySupportTicketStore();
    const first = await store.create(
      { ...base, idempotency_key: "form-1" },
      { clientKey: "a" },
    );
    const second = await store.create(
      { ...base, idempotency_key: "form-1", description: "changed" },
      { clientKey: "a" },
    );
    expect(second.duplicate).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
  });

  it("rate limits repeated submissions from the same client key", async () => {
    const store = new MemorySupportTicketStore({
      rateLimit: { max: 2, windowMs: 60_000 },
      now: (() => {
        let t = 0;
        return () => t;
      })(),
    });
    await store.create({ ...base, description: "one" }, { clientKey: "ip1" });
    await store.create({ ...base, description: "two" }, { clientKey: "ip1" });
    await expect(
      store.create({ ...base, description: "three" }, { clientKey: "ip1" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("dedupes identical content inside the duplicate window", async () => {
    const store = new MemorySupportTicketStore({ now: () => 50 });
    const first = await store.create(base, { clientKey: "a" });
    const second = await store.create(base, { clientKey: "b" });
    expect(second.duplicate).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(duplicateFingerprint(base)).toBe(
      duplicateFingerprint({
        email: base.email,
        category: base.category,
        description: base.description,
      }),
    );
  });

  it("surfaces provider outages without accepting", async () => {
    const store = new MemorySupportTicketStore();
    store.simulateOutage();
    await expect(store.create(base, { clientKey: "a" })).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
    });
  });

  it("accepts anonymous tickets (no wallet) and wallet-authenticated hints", async () => {
    const store = new MemorySupportTicketStore();
    const anon = await store.create(base, { clientKey: "anon" });
    expect(anon.ticket.wallet_address).toBeNull();

    const wallet = "G".padEnd(56, "B");
    const withWallet = await store.create(
      { ...base, email: "other@example.com", description: "wallet path", wallet_address: wallet },
      { clientKey: "wallet" },
    );
    expect(withWallet.ticket.wallet_address).toBe(wallet);
  });
});

describe("clientRateKey", () => {
  it("hashes ip+email without echoing secrets", () => {
    const key = clientRateKey({ ip: "1.2.3.4", email: "ada@example.com" });
    expect(key).toHaveLength(32);
    expect(key).not.toContain("ada");
    expect(key).not.toContain("1.2.3.4");
  });
});
