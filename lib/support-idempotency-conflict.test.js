import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  MemorySupportTicketStore,
  FileSupportTicketStore,
} from "./support-ticket-store.js";

const input = {
  name: "Ada",
  email: "ada@example.test",
  category: "transaction",
  description: "Transfer ABC did not arrive.",
  wallet_address: "0x" + "a".repeat(40),
  idempotency_key: "submitted-form-1",
};
const meta = { clientKey: "one-client" };

describe("support idempotency content", () => {
  it("replays normalized matches and rejects changed content without consuming quota", async () => {
    const store = new MemorySupportTicketStore({
      rateLimit: { max: 1, windowMs: 60000 },
      now: () => 1000,
      random: () => 0.1,
    });
    const original = await store.create(input, meta);
    const match = await store.create({
      ...input,
      name: " Ada ",
      email: " ADA@EXAMPLE.TEST ",
      description: " Transfer ABC did not arrive. ",
      wallet_address: "0x" + "A".repeat(40),
    }, meta);
    assert.equal(match.duplicate, true);
    assert.deepEqual(match.ticket, original.ticket);

    // These are distinct accepted fields, even when the similarity-based
    // duplicate fingerprint would deliberately treat some as equivalent.
    for (const change of [
      { name: "Grace" },
      { email: "grace@example.test" },
      { category: "wallet" },
      { description: "transfer abc did not arrive." },
      { wallet_address: "0x" + "b".repeat(40) },
    ]) {
      await assert.rejects(store.create({ ...input, ...change }, meta), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      assert.equal(store.tickets.size, 1);
      assert.deepEqual(await store.get(original.ticket.id), original.ticket);
      assert.equal(store.rate.get(meta.clientKey).count, 1);
    }
    const retry = await store.create(input, meta);
    assert.equal(retry.ticket.id, original.ticket.id);
    assert.equal(retry.duplicate, true);
  });

  it("preserves durable acceptance across queued conflicts, restart and fresh-key recovery", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "support-conflict-"));
    const filePath = path.join(directory, "tickets.jsonl");
    try {
      const store = new FileSupportTicketStore(filePath, { random: () => 0.1 });
      const changed = { ...input, description: "A different transfer did not arrive." };
      const outcomes = await Promise.allSettled([
        store.create(input, meta),
        store.create(changed, meta),
      ]);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "rejected");
      assert.equal(outcomes[1].reason.code, "IDEMPOTENCY_CONFLICT");
      const original = outcomes[0].value;
      const acceptedBytes = await fs.readFile(filePath, "utf8");
      assert.equal(acceptedBytes.trim().split("\n").length, 1);

      const restarted = new FileSupportTicketStore(filePath, { random: () => 0.2 });
      await assert.rejects(restarted.create(changed, meta), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      assert.equal(await fs.readFile(filePath, "utf8"), acceptedBytes);
      assert.deepEqual((await restarted.create(input, meta)).ticket, original.ticket);
      assert.equal(restarted.rate.size, 0);

      const recovery = await restarted.create({
        ...changed,
        idempotency_key: "submitted-form-2",
      }, meta);
      assert.equal(recovery.duplicate, false);
      assert.notEqual(recovery.ticket.id, original.ticket.id);
      assert.equal(recovery.ticket.description, changed.description);
      assert.deepEqual(await restarted.get(original.ticket.id), original.ticket);
      assert.equal((await fs.readFile(filePath, "utf8")).trim().split("\n").length, 2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
