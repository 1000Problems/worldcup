import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { json, preflight } from "@/lib/http";
import { getMatch, phaseFor, DEFAULT_REF } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /state?roomId=&playerId= → { phase } — the endpoint Rooms polls (see
// Rooms/ROOMS-INTEGRATION.md §3). Same single stable key as the launch token:
// Rooms signs the pull, we verify it here so a player's state can't be probed by
// anyone who guesses the URL. Producer is Rooms/lib/roomState.ts.
//
//   X-Rooms-Timestamp: <ms since epoch>
//   X-Rooms-Signature: hex HMAC_SHA256(ROOMS_SIGNING_KEY, "<ts>:<roomId>:<playerId>")
//
// Fails closed: no key, missing/!match signature, or a stale timestamp → 401.

const REPLAY_WINDOW_MS = 300_000; // 5 min — generous vs. the launch token's 5-min TTL

function signatureOk(roomId: string, playerId: string, ts: string, provided: string): boolean {
  const key = process.env.ROOMS_SIGNING_KEY;
  if (!key) return false; // fail closed when unconfigured

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > REPLAY_WINDOW_MS) return false;

  const expected = createHmac("sha256", key).update(`${ts}:${roomId}:${playerId}`).digest("hex");
  let got: Buffer;
  try {
    got = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  const exp = Buffer.from(expected, "hex");
  return got.length === exp.length && timingSafeEqual(got, exp);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const roomId = url.searchParams.get("roomId") ?? "";
  const playerId = url.searchParams.get("playerId") ?? "";
  if (!roomId || !playerId) return json({ error: "roomId and playerId required" }, 400);

  const ts = req.headers.get("x-rooms-timestamp") ?? "";
  const sig = req.headers.get("x-rooms-signature") ?? "";
  if (!ts || !sig || !signatureOk(roomId, playerId, ts, sig)) {
    return json({ error: "bad signature" }, 401);
  }

  // v1: one deployment, one room, one match. Routing by roomId → ref is a later
  // step (ARCHITECTURE.md); the single configured match answers for now.
  const m = getMatch(DEFAULT_REF);
  if (!m) return json({ error: "no match configured" }, 500);

  return json({ phase: phaseFor(m) });
}

export function OPTIONS() {
  return preflight();
}
