/**
 * Durable support-ticket store (#117).
 *
 * Default implementation appends JSON lines to a file under `.data/` so
 * acceptance survives process restarts on a single host. Tests inject an
 * in-memory store. Rate limits and idempotency live here so the HTTP layer
 * stays thin.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  duplicateFingerprint,
  mintReceiptId,
  validateTicketInput,
} from "./support-tickets.js";

export const DEFAULT_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * @typedef {object} StoredTicket
 * @property {string} id
 * @property {string} status
 * @property {number} created_at
 * @property {string} name
 * @property {string} email
 * @property {string} category
 * @property {string} description
 * @property {string|null} wallet_address
 * @property {string|null} idempotency_key
 * @property {number} schema_version
 */

export class MemorySupportTicketStore {
  constructor(options = {}) {
    this.tickets = new Map();
    this.byIdempotency = new Map();
    this.rate = new Map();
    this.duplicates = new Map();
    this.rateLimit = options.rateLimit || DEFAULT_RATE_LIMIT;
    this.now = options.now || (() => Date.now());
    this.random = options.random || Math.random;
    this.failNext = false;
  }

  simulateOutage() {
    this.failNext = true;
  }

  /**
   * @param {object} input
   * @param {{ clientKey: string }} meta
   */
  async create(input, meta) {
    if (this.failNext) {
      this.failNext = false;
      const err = new Error("support store unavailable");
      err.code = "STORE_UNAVAILABLE";
      throw err;
    }

    const validated = validateTicketInput(input);
    if (!validated.ok) {
      const err = new Error(validated.message);
      err.code = validated.code;
      err.fieldErrors = validated.fieldErrors;
      throw err;
    }

    const ticket = validated.ticket;
    const now = this.now();

    if (ticket.idempotency_key) {
      const existingId = this.byIdempotency.get(ticket.idempotency_key);
      if (existingId) {
        const existing = this.tickets.get(existingId);
        if (existing) {
          return { ticket: existing, duplicate: true };
        }
      }
    }

    const rateKey = meta.clientKey || ticket.email;
    const window = this.rate.get(rateKey);
    if (!window || now > window.resetAt) {
      this.rate.set(rateKey, { count: 1, resetAt: now + this.rateLimit.windowMs });
    } else {
      window.count += 1;
      if (window.count > this.rateLimit.max) {
        const err = new Error("rate limit exceeded");
        err.code = "RATE_LIMITED";
        err.retryAfterMs = Math.max(0, window.resetAt - now);
        throw err;
      }
    }

    const dupKey = duplicateFingerprint(ticket);
    const priorDup = this.duplicates.get(dupKey);
    if (priorDup && now - priorDup.at < DUPLICATE_WINDOW_MS) {
      const existing = this.tickets.get(priorDup.id);
      if (existing) {
        return { ticket: existing, duplicate: true };
      }
    }

    const id = mintReceiptId({ now: () => now, random: this.random });
    /** @type {StoredTicket} */
    const stored = {
      id,
      status: "accepted",
      created_at: now,
      name: ticket.name,
      email: ticket.email,
      category: ticket.category,
      description: ticket.description,
      wallet_address: ticket.wallet_address,
      idempotency_key: ticket.idempotency_key,
      schema_version: ticket.schema_version,
    };

    // Only persisted receipts may be returned by get() or duplicate retries.
    if (this.persist) await this.persist(stored);
    this.tickets.set(id, stored);
    if (ticket.idempotency_key) {
      this.byIdempotency.set(ticket.idempotency_key, id);
    }
    this.duplicates.set(dupKey, { id, at: now });
    return { ticket: stored, duplicate: false };
  }

  async get(id) {
    return this.tickets.get(id) || null;
  }
}

/**
 * File-backed store. Loads existing JSONL on construct; appends on create.
 */
export class FileSupportTicketStore extends MemorySupportTicketStore {
  /**
   * @param {string} filePath
   * @param {object} [options]
   */
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
    this._loaded = false;
    this._loadPromise = null;
    this._createQueue = Promise.resolve();
  }

  async ensureLoaded() {
    if (this._loaded) return;
    if (!this._loadPromise) {
      this._loadPromise = this._loadFromFile()
        .then(() => {
          this._loaded = true;
        })
        .finally(() => {
          this._loadPromise = null;
        });
    }
    await this._loadPromise;
  }

  async _loadFromFile() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.id) {
            this.tickets.set(row.id, row);
            if (row.idempotency_key) {
              this.byIdempotency.set(row.idempotency_key, row.id);
            }
            // A restart must preserve, not renew, the original duplicate window.
            this.duplicates.set(duplicateFingerprint(row), {
              id: row.id,
              at: row.created_at,
            });
          }
        } catch {
          // skip corrupt lines
        }
      }
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }

  async persist(stored) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(stored)}\n`, "utf8");
  }

  async create(input, meta) {
    // Concurrent retries must await the durable outcome of the prior write.
    const pending = this._createQueue.then(async () => {
      await this.ensureLoaded();
      return super.create(input, meta);
    });
    // A failed append must not prevent a later request from retrying storage.
    this._createQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async get(id) {
    await this.ensureLoaded();
    return super.get(id);
  }
}

/** Hash IP / email into a stable rate-limit key without logging the raw value. */
export function clientRateKey({ ip, email }) {
  const material = `${ip || "unknown"}|${(email || "").toLowerCase()}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

let singleton;

export function getSupportTicketStore() {
  if (!singleton) {
    const filePath =
      process.env.SUPPORT_TICKET_STORE_PATH ||
      path.join(process.cwd(), ".data", "support-tickets.jsonl");
    singleton = new FileSupportTicketStore(filePath);
  }
  return singleton;
}

export function resetSupportTicketStoreForTests(store) {
  singleton = store || null;
}
