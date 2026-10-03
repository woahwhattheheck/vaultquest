"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";
import {
  connectedPublicKey,
} from "@vaultquest/stellar-wallet-connect/src/core/store";
import {
  DEFAULT_PREFS,
  loadNotificationPrefs,
  saveNotificationPrefs,
  OPTIONAL_PREF_KEYS,
} from "@/lib/notification-prefs";

function useNanostoreValue(store, fallback) {
  const [value, setValue] = useState(() => {
    try {
      return store?.get?.() ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (!store || typeof store.subscribe !== "function") return undefined;
    setValue(store.get?.() ?? fallback);
    return store.subscribe((next) => setValue(next ?? fallback));
  }, [store, fallback]);

  return value;
}

const TOGGLE_ROWS = [
  {
    key: "roundUpdates",
    title: "Round Updates",
    description: "Get notified when rounds complete",
  },
  {
    key: "actionStatus",
    title: "Action Status Updates",
    description: "Deposits, withdrawals, and claims",
  },
  {
    key: "winnings",
    title: "Winning Notifications",
    description: "Alert when you win a prize",
  },
  {
    key: "deposits",
    title: "Deposit Confirmations",
    description: "Confirm each deposit action",
  },
];

export default function VaultNotificationSettings({
  storage,
  fetchImpl,
} = {}) {
  const wallet = useNanostoreValue(connectedPublicKey, "");
  const browserStorage =
    storage ||
    (typeof window !== "undefined" ? window.localStorage : null);
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  const [settings, setSettings] = useState({ ...DEFAULT_PREFS });
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [loadedWallet, setLoadedWallet] = useState("");
  const walletSession = useRef(null);
  const isReady = Boolean(wallet) && loadedWallet === wallet;

  useEffect(() => {
    const session = { wallet: wallet || "", active: true, saving: false };
    walletSession.current = session;
    const controller = new AbortController();
    let timeout;
    const isCurrent = () => session.active && walletSession.current === session;

    setLoadedWallet("");
    setSettings({ ...DEFAULT_PREFS });
    setError(null);
    setShowSaved(false);
    setIsSaving(false);

    async function hydrate() {
      if (!session.wallet) return;

      if (browserStorage) {
        const local = loadNotificationPrefs(browserStorage, session.wallet);
        if (local.ok && local.record) {
          setSettings({ ...DEFAULT_PREFS, ...local.record.prefs });
        } else if (!local.ok && local.reason === "newer-version") {
          setError("Saved preferences use a newer format and were left untouched.");
          setSettings({ ...DEFAULT_PREFS });
        } else if (!local.ok && local.reason === "corrupt") {
          setError("Saved preferences were unreadable and were left untouched.");
          setSettings({ ...DEFAULT_PREFS });
        } else {
          setSettings({ ...DEFAULT_PREFS });
        }
      }

      if (doFetch) {
        timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await doFetch(
            `/api/notification-prefs?wallet=${encodeURIComponent(session.wallet)}`,
            { signal: controller.signal },
          );
          if (!isCurrent()) return;
          if (res.ok) {
            const json = await res.json();
            if (isCurrent() && json?.data?.prefs) {
              setSettings({ ...DEFAULT_PREFS, ...json.data.prefs, securityNotices: true });
            }
          }
        } catch {
          // Local prefs remain authoritative if the server is unreachable.
        } finally {
          clearTimeout(timeout);
        }
      }

      if (isCurrent()) setLoadedWallet(session.wallet);
    }

    void hydrate();
    return () => {
      // Cancel reads and invalidate completions, including a switch back to
      // the same wallet while an older request is still in flight.
      session.active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [wallet, browserStorage, doFetch]);

  const toggleSetting = (key) => {
    if (
      !isReady ||
      isSaving ||
      walletSession.current?.saving ||
      !OPTIONAL_PREF_KEYS.includes(key)
    ) return;
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
    setShowSaved(false);
    setError(null);
  };

  const handleSave = async () => {
    if (!wallet) {
      setError("Connect a wallet to save notification preferences.");
      return;
    }

    const session = walletSession.current;
    if (
      !isReady ||
      !session?.active ||
      session.wallet !== wallet ||
      session.saving
    ) return;
    session.saving = true;
    const isCurrent = () => session.active && walletSession.current === session;

    setError(null);
    setShowSaved(false);
    setIsSaving(true);
    try {
      if (browserStorage) {
        const local = saveNotificationPrefs(browserStorage, wallet, settings);
        if (!local.ok) {
          setError(
            local.reason === "write-failed"
              ? "Could not write preferences to this browser (storage blocked)."
              : "Could not save preferences locally.",
          );
          return;
        }
      }

      if (doFetch) {
        const res = await doFetch("/api/notification-prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_address: wallet,
            prefs: {
              roundUpdates: settings.roundUpdates,
              actionStatus: settings.actionStatus,
              winnings: settings.winnings,
              deposits: settings.deposits,
              securityNotices: true,
            },
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!isCurrent()) return;
        if (!res.ok) {
          setError("Preferences were saved on this device, but the server copy failed. Retry when online.");
          // Still treat local save as partial success indicator? Prefer honest error.
          return;
        }
      }

      if (isCurrent()) setShowSaved(true);
    } catch {
      if (isCurrent()) {
        setError("Preferences could not be saved right now. Try again.");
      }
    } finally {
      session.saving = false;
      if (isCurrent()) setIsSaving(false);
    }
  };

  return (
    <section
      className="vq-glass-hover p-6 space-y-4"
      aria-busy={Boolean(wallet) && (!isReady || isSaving)}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
          <Bell size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-vault-text">
            Notification Preferences
          </h3>
          <p className="text-sm text-vault-muted">
            {wallet
              ? "Manage vault alerts for the connected wallet"
              : "Connect a wallet to load and save preferences"}
          </p>
        </div>
      </div>

      <div className="space-y-3 border-t border-vault-border pt-4">
        {TOGGLE_ROWS.map((row) => (
          <label
            key={row.key}
            className="flex items-center justify-between cursor-pointer group"
          >
            <div>
              <p className="font-medium text-vault-text group-hover:text-vault-accent transition-colors">
                {row.title}
              </p>
              <p className="text-xs text-vault-muted">{row.description}</p>
            </div>
            <input
              type="checkbox"
              checked={Boolean((isReady ? settings : DEFAULT_PREFS)[row.key])}
              onChange={() => toggleSetting(row.key)}
              disabled={!isReady || isSaving}
              className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent"
            />
          </label>
        ))}

        <div className="flex items-start justify-between gap-3 rounded-xl border border-vault-border bg-vault-surface/40 p-3">
          <div className="flex items-start gap-2">
            <ShieldCheck size={18} className="mt-0.5 text-vault-accent shrink-0" />
            <div>
              <p className="font-medium text-vault-text">Security notices</p>
              <p className="text-xs text-vault-muted">
                Mandatory alerts for account security stay on and cannot be disabled.
              </p>
            </div>
          </div>
          <input
            type="checkbox"
            checked
            disabled
            readOnly
            aria-label="Security notices (required)"
            className="h-5 w-5 rounded border-vault-border text-vault-accent opacity-70"
          />
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={isSaving || !isReady}
        className="vq-btn-primary w-full disabled:opacity-60"
      >
        {wallet && !isReady
          ? "Loading preferences…"
          : isSaving ? "Saving…" : "Save Preferences"}
      </button>

      {showSaved && isReady && (
        <div className="flex items-center gap-2 text-sm text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
          <CheckCircle2 size={16} />
          <span>
            Notification preferences saved
            {loadedWallet ? " for this wallet" : ""}
          </span>
        </div>
      )}

      {error && isReady && (
        <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
