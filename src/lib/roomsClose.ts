import { createHmac } from "node:crypto";
import { listPicks, launchCtx, scorePicks, type ResultDef } from "@/lib/rooms";

// ---------------------------------------------------------------------------
// Push resolved results to Rooms — the ONLY thing Rooms learns about a match
// (Rooms/ROOMS-INTEGRATION.md §4). We send placement + rewards keyed by playerId,
// and NEVER the pick. Signed with the single stable per-room key over the exact
// raw body. Rooms mints once and dedups, so a retry can't double-grant.
// ---------------------------------------------------------------------------

type CloseResult = {
  playerId: string;
  placement: number;
  rewards: { trophy?: { label: string }; xp?: number; badges?: string[] };
};

const TROPHY_LABEL = "Oracle of Atlanta";
const CORRECT_OUTCOME_FLOOR = 1_000_000; // points at/above this ⇒ right winner/draw

// Standard competition ranking by points — ties share a rank and the next rank
// skips it (e.g. 1, 1, 3, not 1, 1, 2) — mapped to rewards. Pure.
async function toResults(result: ResultDef): Promise<CloseResult[]> {
  const board = scorePicks(result, await listPicks(result.ref)).sort((a, b) => b.points - a.points);

  const out: CloseResult[] = [];
  let placement = 0;
  let prevPoints = Number.POSITIVE_INFINITY;
  let seen = 0;
  for (const row of board) {
    seen++;
    if (row.points < prevPoints) {
      placement = seen; // first of a new (lower) score tier takes its rank
      prevPoints = row.points;
    }
    const correct = row.points >= CORRECT_OUTCOME_FLOOR;
    const badges: string[] = [];
    if (correct) badges.push("called-it");
    if (row.detail.score.exact) badges.push("exact-score");

    // xp is advisory; Rooms caps it 0–100 regardless.
    const rewards: CloseResult["rewards"] = { xp: placement === 1 ? 25 : correct ? 12 : 4 };
    if (placement === 1 && row.points > 0) rewards.trophy = { label: TROPHY_LABEL };
    if (badges.length) rewards.badges = badges;

    out.push({ playerId: row.playerId, placement, rewards });
  }
  return out;
}

export type PushOutcome = { ok: boolean; status?: number; skipped?: string };

export async function pushClose(result: ResultDef): Promise<PushOutcome> {
  const key = process.env.ROOMS_SIGNING_KEY;
  const ctx = await launchCtx(result.ref);
  if (!key) return { ok: false, skipped: "ROOMS_SIGNING_KEY not set" };
  if (!ctx) return { ok: false, skipped: "no launch context (no verified picks captured)" };

  const results = await toResults(result);
  if (results.length === 0) return { ok: false, skipped: "no picks to report" };

  // Sign the EXACT bytes we send — Rooms recomputes the HMAC over the raw body.
  const body = JSON.stringify({ roomId: ctx.roomId, results });
  const sig = createHmac("sha256", key).update(body).digest("hex");

  try {
    const res = await fetch(`${ctx.roomsHost.replace(/\/+$/, "")}/api/rooms/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rooms-signature": sig },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false }; // network/host down — admin can re-resolve to retry
  }
}
