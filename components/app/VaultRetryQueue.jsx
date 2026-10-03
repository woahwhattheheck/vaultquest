"use client";

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  AlertCircle,
  RefreshCw,
  Trash2,
  XCircle,
  CheckCircle2,
  Clock,
  Wallet,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { createRetryQueueClient } from "@/lib/retry-queue-client";
import {
  canCancelAction,
  canRetryAction,
  getErrorUserMessage,
} from "@/lib/retry-queue-policy";

function useStoreValue(store, fallback) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    setValue(store.get());
    return store.subscribe(setValue);
  }, [store]);
  return value;
}

function StatusBadge({ status }) {
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
      <Clock className="h-3 w-3" aria-hidden="true" />
      Pending
    </span>
  );
}

function ActionIcon({ type }) {
  if (type === "deposit") {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Wallet className="h-5 w-5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-muted">
      <Wallet className="h-5 w-5" aria-hidden="true" />
    </span>
  );
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function QueuedAction({ action, onRetry, onCancel, onDismiss, busy }) {
  const retryDecision = canRetryAction(action);
  const cancelDecision = canCancelAction(action);
  const isPending = action.status === "pending";
  const showRetry = !isPending && retryDecision.ok;
  const showCancel = isPending && cancelDecision.ok;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-4 rounded-xl border border-vault-border bg-vault-surface/50 p-4"
      data-action-id={action.id}
      data-ledger-status={action.status}
    >
      <ActionIcon type={action.type} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium capitalize text-vault-text">{action.type}</p>
          <StatusBadge status={action.status} />
          {action.retryCount > 0 && (
            <span className="text-xs text-vault-muted">Retry #{action.retryCount}</span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-vault-muted">
          {action.pool} &middot; {action.amount} {action.token}
        </p>
        <p className="text-xs text-vault-muted">{formatTimeAgo(action.createdAt)}</p>
        {action.errorCode && (
          <p className="mt-1 text-xs text-red-500 dark:text-red-400">
            {getErrorUserMessage(action.errorCode, action.errorDetail)}
          </p>
        )}
        {!retryDecision.ok && action.status === "failed" && (
          <p className="mt-1 text-xs text-vault-muted">
            Not retryable ({String(retryDecision.reason || "").replace(/_/g, " ")}).
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {showRetry && (
          <button
            type="button"
            onClick={() => onRetry(action)}
            disabled={busy}
            className="vq-btn-primary px-3 py-1.5 text-xs"
            aria-label={`Retry ${action.type}`}
          >
            {busy ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={() => (showCancel ? onCancel(action) : onDismiss(action))}
          disabled={busy}
          className="vq-btn-ghost px-2 py-1.5 text-xs"
          aria-label={showCancel ? "Cancel pending action" : "Dismiss"}
        >
          {showCancel ? (
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {showCancel ? "Cancel" : "Dismiss"}
        </button>
      </div>
    </motion.li>
  );
}

/**
 * Ledger-backed retry queue (#121).
 *
 * Loads retryable actions from the authenticated action ledger, enforces the
 * error-code retry policy, creates a fresh linked intent on retry (never
 * auto-signs), and cancels pending actions idempotently on the ledger.
 */
export default function VaultRetryQueue({
  walletAddress: walletAddressProp,
  client: clientProp,
  requestSign,
  getAuthHeaders,
} = {}) {
  const connected = useStoreValue(connectedPublicKey, "");
  const walletAddress = walletAddressProp ?? connected ?? "";

  const client = useMemo(
    () =>
      clientProp ||
      createRetryQueueClient({
        getAuthHeaders:
          getAuthHeaders ||
          (async () =>
            walletAddress ? { "X-Wallet-Address": walletAddress } : {}),
      }),
    [clientProp, getAuthHeaders, walletAddress]
  );

  const [actions, setActions] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const inFlightRef = useRef(new Set());
  const dismissedRef = useRef(new Set());

  const reload = useCallback(async () => {
    if (!walletAddress) {
      setActions([]);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await client.listQueueActions(walletAddress);
      setActions(rows.filter((r) => !dismissedRef.current.has(r.id)));
    } catch (err) {
      setLoadError(err?.message || "Failed to load retry queue");
      setActions([]);
    } finally {
      setLoading(false);
    }
  }, [client, walletAddress]);

  // Reload when the connected wallet changes; clear local state so rows never
  // leak across identities.
  useEffect(() => {
    dismissedRef.current = new Set();
    inFlightRef.current = new Set();
    setActionError(null);
    reload();
  }, [walletAddress, reload]);

  const failedCount = actions.filter((a) => a.status === "failed").length;
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  const totalCount = actions.length;

  const handleRetry = useCallback(
    async (action) => {
      if (!walletAddress) return;
      if (inFlightRef.current.has(action.id)) {
        setActionError("Retry already in progress (duplicate click ignored).");
        return;
      }

      inFlightRef.current.add(action.id);
      setBusyId(action.id);
      setActionError(null);

      try {
        let fresh = action;
        if (typeof client.getAction === "function") {
          try {
            fresh = (await client.getAction(action.id)) || action;
          } catch {
            fresh = action;
          }
        }

        if (fresh.status === "confirmed") {
          setActionError("Action was confirmed on-chain; retry blocked.");
          dismissedRef.current.add(action.id);
          setActions((prev) => prev.filter((a) => a.id !== action.id));
          return;
        }

        const { action: created } = await client.createRetryAttempt(action, {
          walletAddress,
          freshAction: fresh,
          requestSign,
        });

        dismissedRef.current.add(action.id);
        setActions((prev) => {
          const withoutParent = prev.filter((a) => a.id !== action.id);
          if (created && !withoutParent.some((a) => a.id === created.id)) {
            return [created, ...withoutParent];
          }
          return withoutParent;
        });
      } catch (err) {
        setActionError(err?.message || "Retry failed");
      } finally {
        inFlightRef.current.delete(action.id);
        setBusyId(null);
      }
    },
    [client, requestSign, walletAddress]
  );

  const handleCancel = useCallback(
    async (action) => {
      if (!walletAddress) return;
      if (inFlightRef.current.has(action.id)) {
        setActionError("Cancel already in progress (duplicate click ignored).");
        return;
      }

      inFlightRef.current.add(action.id);
      setBusyId(action.id);
      setActionError(null);

      try {
        await client.cancelAction(action, {
          walletAddress,
        });
        dismissedRef.current.add(action.id);
        setActions((prev) => prev.filter((a) => a.id !== action.id));
      } catch (err) {
        if (err?.code === "already_failed" || err?.details?.dismissLocally) {
          dismissedRef.current.add(action.id);
          setActions((prev) => prev.filter((a) => a.id !== action.id));
        } else {
          setActionError(err?.message || "Cancel failed");
        }
      } finally {
        inFlightRef.current.delete(action.id);
        setBusyId(null);
      }
    },
    [client, walletAddress]
  );

  const handleDismiss = useCallback((action) => {
    dismissedRef.current.add(action.id);
    setActions((prev) => prev.filter((a) => a.id !== action.id));
  }, []);

  const handleClearAll = useCallback(() => {
    for (const a of actions) dismissedRef.current.add(a.id);
    setActions([]);
  }, [actions]);

  if (!walletAddress) return null;
  if (!loading && !loadError && totalCount === 0) return null;

  return (
    <section
      className="vq-glass p-4 sm:p-6"
      role="region"
      aria-label="Transaction retry queue"
      data-wallet={walletAddress}
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left"
          aria-expanded={!collapsed}
          aria-controls="retry-queue-content"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-vault-text">Pending Actions</h2>
          </div>
          <div className="flex gap-1.5">
            {failedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                {failedCount} failed
              </span>
            )}
            {pendingCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {pendingCount} pending
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reload}
            className="vq-btn-ghost px-3 py-1.5 text-xs"
            aria-label="Refresh retry queue from ledger"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh
          </button>
          {totalCount > 1 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="vq-btn-ghost px-3 py-1.5 text-xs"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="vq-btn-ghost px-3 py-1.5 text-xs"
            aria-label={collapsed ? "Expand queue" : "Collapse queue"}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            id="retry-queue-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {loadError && (
              <p className="mt-2 text-sm text-red-500" role="alert">
                {loadError}
              </p>
            )}
            {actionError && (
              <p className="mt-2 text-sm text-red-500" role="alert">
                {actionError}
              </p>
            )}
            <p className="mt-2 text-sm text-vault-muted">
              {loading
                ? "Loading actions from the ledger…"
                : failedCount > 0
                  ? `${failedCount} transaction${failedCount > 1 ? "s" : ""} failed. Retry creates a fresh signed attempt linked to the original ledger record.`
                  : `${pendingCount} transaction${pendingCount > 1 ? "s" : ""} waiting to be processed.`}
            </p>

            <ul className="mt-4 space-y-3" role="list">
              <AnimatePresence>
                {actions.map((action) => (
                  <QueuedAction
                    key={action.id}
                    action={action}
                    onRetry={handleRetry}
                    onCancel={handleCancel}
                    onDismiss={handleDismiss}
                    busy={busyId === action.id}
                  />
                ))}
              </AnimatePresence>
            </ul>

            {totalCount > 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-vault-surface/50 px-4 py-3 text-xs text-vault-muted">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                Retries never auto-sign. Successful attempts appear in Activity after confirmation.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
