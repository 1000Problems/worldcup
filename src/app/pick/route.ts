import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getChatSession } from "@/lib/chatSession";
import { getMatch, phaseFor, validatePick, recordPick, type Pick } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// POST /pick { ref, pick } — capture a prediction in OUR private store.
//
// The pick NEVER leaves worldcup. Rooms only ever sees resolved results (/close);
// it has no idea what anyone picked. Identity is taken from the verified Rooms
// session cookie, not the request body, so a pick is always bound to a real
// launched player and can't be filed under someone else's id. Picks are final at
// lock: we refuse once the match is no longer open.
export async function POST(req: NextRequest) {
  const player = getChatSession();
  if (!player) return json({ error: "no verified Rooms session" }, 401);

  const body = await req.json().catch(() => null);
  const ref: string | undefined = body?.ref;
  const m = ref ? getMatch(ref) : null;
  if (!m) return json({ error: "unknown event ref" }, 404);

  if (phaseFor(m) !== "open") return json({ error: "picks are closed" }, 409);

  const check = validatePick(m, body?.pick);
  if (!check.valid) return json({ error: check.reason ?? "invalid pick" }, 400);

  // Harvest the launch context so /close can be pushed with only ROOMS_SIGNING_KEY
  // set: roomId identifies us to Rooms, returnUrl's origin is where /close lives.
  let roomsHost = "";
  try {
    roomsHost = new URL(player.returnUrl).origin;
  } catch {
    /* returnUrl absent/malformed — ctx simply won't be recorded */
  }

  recordPick(m.ref, player.playerId, body.pick as Pick, { roomId: player.roomId, roomsHost });
  return json({ ok: true });
}

export function OPTIONS() {
  return preflight();
}
