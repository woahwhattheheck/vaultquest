import { NextResponse } from "next/server";
import { getNotificationPrefsServerStore } from "@/lib/notification-prefs-server";
import { OPTIONAL_PREF_KEYS } from "@/lib/notification-prefs";

export const dynamic = "force-dynamic";

function requireWallet(value) {
  if (!value || typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

/**
 * GET /api/notification-prefs?wallet=...
 * PUT /api/notification-prefs { wallet_address, prefs }
 *
 * Wallet address is a scoping principal, not proof of control by itself —
 * the Next proxy trusts same-origin UI the same way /api/profile does today.
 */
export async function GET(req) {
  const wallet = requireWallet(req.nextUrl.searchParams.get("wallet"));
  if (!wallet) {
    return NextResponse.json(
      { error: { code: "NO_WALLET", message: "wallet is required" } },
      { status: 400 },
    );
  }
  const store = getNotificationPrefsServerStore();
  const record = await store.get(wallet);
  return NextResponse.json(
    { data: record },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "invalid JSON body" } },
      { status: 400 },
    );
  }

  const wallet = requireWallet(body?.wallet_address || body?.wallet);
  if (!wallet) {
    return NextResponse.json(
      { error: { code: "NO_WALLET", message: "wallet_address is required" } },
      { status: 400 },
    );
  }

  const prefs = body?.prefs;
  if (!prefs || typeof prefs !== "object") {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "prefs object is required" } },
      { status: 400 },
    );
  }

  for (const key of Object.keys(prefs)) {
    if (![...OPTIONAL_PREF_KEYS, "securityNotices"].includes(key)) {
      return NextResponse.json(
        { error: { code: "INVALID_PAYLOAD", message: `unknown pref key: ${key}` } },
        { status: 400 },
      );
    }
    if (typeof prefs[key] !== "boolean") {
      return NextResponse.json(
        { error: { code: "INVALID_PAYLOAD", message: `pref ${key} must be boolean` } },
        { status: 400 },
      );
    }
  }

  try {
    const store = getNotificationPrefsServerStore();
    const record = await store.put(wallet, prefs);
    return NextResponse.json({ data: record });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: "STORE_UNAVAILABLE",
          message: "preferences could not be saved right now",
        },
      },
      { status: 503 },
    );
  }
}
