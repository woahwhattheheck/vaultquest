/**
 * Server-side durable notification prefs (#118).
 * File-backed JSON map keyed by wallet; tests inject Memory store.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PREFS,
  NOTIFICATION_PREFS_VERSION,
  OPTIONAL_PREF_KEYS,
  createDefaultRecord,
  parsePrefsRecord,
} from "./notification-prefs.js";

export class MemoryNotificationPrefsServerStore {
  constructor() {
    this.byWallet = new Map();
  }

  async get(wallet) {
    if (!wallet) return createDefaultRecord("anonymous");
    const existing = this.byWallet.get(wallet.trim().toLowerCase());
    if (!existing) return createDefaultRecord(wallet);
    return existing;
  }

  async put(wallet, prefs, now = Date.now()) {
    if (!wallet || !String(wallet).trim()) {
      const err = new Error("wallet is required");
      err.code = "NO_WALLET";
      throw err;
    }
    const next = { ...DEFAULT_PREFS };
    for (const k of OPTIONAL_PREF_KEYS) {
      if (typeof prefs?.[k] === "boolean") next[k] = prefs[k];
    }
    next.securityNotices = true;
    const record = {
      version: NOTIFICATION_PREFS_VERSION,
      wallet: wallet.trim(),
      prefs: next,
      updatedAt: now,
    };
    this.byWallet.set(wallet.trim().toLowerCase(), record);
    await this.persistAll?.();
    return record;
  }
}

export class FileNotificationPrefsServerStore extends MemoryNotificationPrefsServerStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this._loaded = false;
  }

  async ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [wallet, record] of Object.entries(parsed)) {
          const result = parsePrefsRecord(record, wallet);
          if (result.ok && result.record) {
            this.byWallet.set(wallet.toLowerCase(), result.record);
          }
        }
      }
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }

  async persistAll() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const obj = Object.fromEntries(this.byWallet.entries());
    await fs.writeFile(this.filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  async get(wallet) {
    await this.ensureLoaded();
    return super.get(wallet);
  }

  async put(wallet, prefs, now) {
    await this.ensureLoaded();
    return super.put(wallet, prefs, now);
  }
}

let singleton;
export function getNotificationPrefsServerStore() {
  if (!singleton) {
    const filePath =
      process.env.NOTIFICATION_PREFS_STORE_PATH ||
      path.join(process.cwd(), ".data", "notification-prefs.json");
    singleton = new FileNotificationPrefsServerStore(filePath);
  }
  return singleton;
}

export function resetNotificationPrefsServerStoreForTests(store) {
  singleton = store || null;
}
