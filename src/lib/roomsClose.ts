import { createHmac } from "node:crypto";
import {
  listPicks,
  launchCtx,
  scorePicks,
  seriesForEvent,
  getSeries,
  getResult,
  seriesPhase,
  type ResultDef,
  type LaunchCtx,
} from "@/lib/rooms";

// ---------------------------------------------------------------------------
// Push resolved results to Rooms — the ONLY thing Rooms learns about a match
// (Rooms/ROOMS-INTEGRATION.md §4). We send placement + rewards keyed by playerId,
// and NEVER the pick. Signed with the single stable per-room key over the exact
// raw body. Rooms mints once and dedups, so a retry can't double-grant.
//
// Two messages, both for ALL players:
//   - pushClose(result)     → EVENT close, one per match. Rooms mints the event trophy.
//   - pushSeriesClose(sref)  → SERIES close, once the whole series is decided. Rooms
//                              mints the series trophy to whoever WE rank first; it
//                              never re-derives the standing (the aggregation is ours).
// ---------------------------------------------------------------------------

type CloseResult = {
  playerId: string;
  points: number; // raw cascade points — the host sums these for the series aggregate
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

    out.push({ playerId: row.playerId, points: row.points, placement, rewards });
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

  // Attribute the board to its series so the host can recompute the aggregate.
  // null for a standalone match (in no series) — it still closes the same way.
  const sref = seriesForEvent(result.ref)?.ref ?? null;

  // Sign the EXACT bytes we send — Rooms recomputes the HMAC over the raw body.
  // The full board (every player) keyed by playerId, plus the event ref so the
  // host anchors the per-event trophy on (sref, ref). NEVER picks.
  const body = JSON.stringify({
    type: "event-close",
    roomId: ctx.roomId,
    sref,
    ref: result.ref,
    trophyLabel: TROPHY_LABEL,
    results,
  });
  return post(ctx.roomsHost, body, key);
}

// POST one signed message to Rooms' /close. Non-fatal: a network/host failure
// returns ok:false so the operator can re-resolve to retry.
async function post(roomsHost: string, body: string, key: string): Promise<PushOutcome> {
  const sig = createHmac("sha256", key).update(body).digest("hex");
  try {
    const res = await fetch(`${roomsHost.replace(/\/+$/, "")}/api/rooms/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rooms-signature": sig },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

// SERIES close — fired once the whole series is decided. We compute OUR own
// standing (the aggregation rule lives here, not in Rooms) and push it ranked;
// the host mints the series trophy to placement 1 without re-deriving anything.
export async function pushSeriesClose(sref: string): Promise<PushOutcome> {
  const key = process.env.ROOMS_SIGNING_KEY;
  if (!key) return { ok: false, skipped: "ROOMS_SIGNING_KEY not set" };

  const series = getSeries(sref);
  if (!series) return { ok: false, skipped: "unknown series" };

  // The room is the authority on completion — only push when every event closed.
  if ((await seriesPhase(sref)) !== "completed") return { ok: false, skipped: "series not complete" };

  // Identify ourselves to Rooms via any member event's launch context.
  let ctx: LaunchCtx | null = null;
  for (const ref of series.eventRefs) {
    ctx = await launchCtx(ref);
    if (ctx) break;
  }
  if (!ctx) return { ok: false, skipped: "no launch context" };

  // OUR aggregation rule: sum each player's per-event cascade points across the
  // series. Kept here so it can change (weighting, drop-lowest, bonuses) without
  // touching the host. A player who played one event still appears.
  const totals = new Map<string, number>();
  for (const ref of series.eventRefs) {
    const result = await getResult(ref);
    if (!result) continue;
    for (const row of scorePicks(result, await listPicks(ref))) {
      totals.set(row.playerId, (totals.get(row.playerId) ?? 0) + row.points);
    }
  }
  if (totals.size === 0) return { ok: false, skipped: "no scores to report" };

  // Standard competition ranking (ties share a rank; the next rank skips).
  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  const standing: Array<{ playerId: string; points: number; placement: number }> = [];
  let placement = 0, prev = Number.POSITIVE_INFINITY, seen = 0;
  for (const [playerId, points] of ranked) {
    seen++;
    if (points < prev) { placement = seen; prev = points; }
    standing.push({ playerId, points, placement });
  }

  const body = JSON.stringify({
    type: "series-close",
    roomId: ctx.roomId,
    sref,
    eventRefs: series.eventRefs,
    trophyLabel: series.trophyLabel,
    standing,
  });
  return post(ctx.roomsHost, body, key);
}
