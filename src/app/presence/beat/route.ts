import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getChatSession } from "@/lib/chatSession";
import { recordPresence } from "@/lib/presence";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

// POST /presence/beat  { matchRef?: string }
// Heartbeat. Identity comes from the verified session cookie — the body's only job
// is to say which match (if any) the player is in. No session → nothing written
// (verified-only); the rails simply won't show or count an unauthenticated visitor.
export async function POST(req: NextRequest) {
  const player = getChatSession();
  if (!player) return json({ ok: false });

  const payload = await req.json().catch(() => null);
  const matchRef = typeof payload?.matchRef === "string" ? payload.matchRef : null;

  try {
    const written = await recordPresence(player, matchRef);
    return json({ ok: true, ...written });
  } catch (e) {
    return json({ ok: false, error: "presence unavailable", detail: String(e instanceof Error ? e.message : e) }, 503);
  }
}
