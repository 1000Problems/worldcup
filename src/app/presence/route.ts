import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { readPresence, type PresenceScope } from "@/lib/presence";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

// GET /presence?scope=series&id=world-cup-2026   → the lobby rail
// GET /presence?scope=match&id=match-38          → one match's rail
// Returns { online:[{playerId,name,avatar,since}], onlineCount, everCount }.
// Public read (anyone embedded can see who's here); never returns a pick.
export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope");
  const id = req.nextUrl.searchParams.get("id");

  if (scope !== "series" && scope !== "match") {
    return json({ error: "scope must be 'series' or 'match'" }, 400);
  }
  if (!id) return json({ error: "id is required" }, 400);

  try {
    const snapshot = await readPresence(scope as PresenceScope, id);
    return json(snapshot);
  } catch (e) {
    return json({ error: "presence unavailable", detail: String(e instanceof Error ? e.message : e) }, 503);
  }
}
