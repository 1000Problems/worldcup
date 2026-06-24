import { createHmac } from "node:crypto";
import {
  listPicks,
  listRoomsForSeries,
  scorePicks,
  seriesForEvent,
  getSeries,
  getResult,
  seriesPhase,
  type ResultDef,
  type RoomRecord,
} from "@/lib/rooms";

// ---------------------------------------------------------------------------
// Push resolved results to Rooms — the ONLY thing Rooms learns about a match
// (Rooms/ROOMS-INTEGRATION.md §4). We send placement + rewards keyed by playerId,
// and NEVER the pick. Signed with the single stable per-room key over the exact
// raw body. Rooms mints once and dedups, so a retry can't double-grant.
//
// FAN-OUT (private games): an event resolves for EVERY room playing its series —
// the public room plus each private room. We push /close once per room, each
// carrying that room's own roomId and a board computed from that room's own picks
// (GAME-INTEGRATION-PRIVATE.md §3). Identical signing per push; a room with no
// picks is skipped (nothing to close).
//
//   - pushClose(result)     → EVENT close, one push per room. Rooms mints the event trophy.
//   - pushSeriesClose(sref)  → SERIES close, once the whole series is decided. Rooms
//                              mints the series trophy to whoever WE rank first in
//                              each room; it never re-derives the standing.
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
// skips it (e.g. 1, 1, 3, not 1, 1, 2) — mapped to rewards. Pure over its board.
function toResults(board: ReturnType<typeof scorePicks>): CloseResult[] {
  const ranked = board.slice().sort((a, b) => b.points - a.points);
  const out: CloseResult[] = [];
  let placement = 0;
  let prevPoints = Number.POSITIVE_INFINITY;
  let seen = 0;
  for (const row of ranked) {
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

// One push outcome aggregated across the fan-out. `pushed`/`failed` count rooms;
// `skipped` explains a no-op (no rooms, no key). The operator re-resolves to retry.
export type PushOutcome = {
  ok: boolean;
  pushed?: number;
  failed?: number;
  status?: number;
  skipped?: string;
};

export async function pushClose(result: ResultDef): Promise<PushOutcome> {
  const key = process.env.ROOMS_SIGNING_KEY;
  if (!key) return { ok: false, skipped: "ROOMS_SIGNING_KEY not set" };

  // Attribute the board to its series so the host can recompute the aggregate.
  // null on the wire for a standalone match (in no series); we still enumerate its
  // room(s) under the event ref used as the registry key.
  const series = seriesForEvent(result.ref);
  const sref = series?.ref ?? null;
  const rooms = await listRoomsForSeries(series?.ref ?? result.ref);
  if (rooms.length === 0) return { ok: false, skipped: "no rooms (no verified picks captured)" };

  let pushed = 0;
  let failed = 0;
  let lastStatus: number | undefined;
  for (const room of rooms) {
    const board = scorePicks(result, await listPicks(room.roomId, result.ref));
    if (board.length === 0) continue; // empty room — nothing to close
    if (!room.roomsHost) {
      failed++;
      continue;
    }

    // Sign the EXACT bytes we send — Rooms recomputes the HMAC over the raw body.
    // The full board (every player in THIS room) keyed by playerId, plus the event
    // ref so the host anchors the per-event trophy on (sref, ref). NEVER picks.
    const body = JSON.stringify({
      type: "event-close",
      roomId: room.roomId,
      sref,
      ref: result.ref,
      trophyLabel: TROPHY_LABEL,
      results: toResults(board),
    });
    const out = await post(room.roomsHost, body, key);
    if (out.ok) pushed++;
    else {
      failed++;
      lastStatus = out.status;
    }
  }

  if (pushed === 0 && failed === 0) return { ok: false, skipped: "no picks in any room" };
  return { ok: failed === 0, pushed, failed, status: lastStatus };
}

// POST one signed message to Rooms' /close. Non-fatal: a network/host failure
// returns ok:false so the operator can re-resolve to retry.
async function post(roomsHost: string, body: string, key: string): Promise<{ ok: boolean; status?: number }> {
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
// standing per room (the aggregation rule lives here, not in Rooms) and push it
// ranked; the host mints each room's series trophy to that room's placement 1
// without re-deriving anything. Fans out exactly like pushClose.
export async function pushSeriesClose(sref: string): Promise<PushOutcome> {
  const key = process.env.ROOMS_SIGNING_KEY;
  if (!key) return { ok: false, skipped: "ROOMS_SIGNING_KEY not set" };

  const series = getSeries(sref);
  if (!series) return { ok: false, skipped: "unknown series" };

  // The room is the authority on completion — only push when every event closed.
  if ((await seriesPhase(sref)) !== "completed") return { ok: false, skipped: "series not complete" };

  const rooms = await listRoomsForSeries(sref);
  if (rooms.length === 0) return { ok: false, skipped: "no rooms" };

  // Pre-load each event's result once; reused for every room's aggregation.
  const results = new Map<string, ResultDef>();
  for (const ref of series.eventRefs) {
    const r = await getResult(ref);
    if (r) results.set(ref, r);
  }

  let pushed = 0;
  let failed = 0;
  let lastStatus: number | undefined;
  for (const room of rooms) {
    const standing = await standingForRoom(room, series.eventRefs, results);
    if (standing.length === 0) continue; // no scores in this room
    if (!room.roomsHost) {
      failed++;
      continue;
    }

    const body = JSON.stringify({
      type: "series-close",
      roomId: room.roomId,
      sref,
      eventRefs: series.eventRefs,
      trophyLabel: series.trophyLabel,
      standing,
    });
    const out = await post(room.roomsHost, body, key);
    if (out.ok) pushed++;
    else {
      failed++;
      lastStatus = out.status;
    }
  }

  if (pushed === 0 && failed === 0) return { ok: false, skipped: "no scores to report" };
  return { ok: failed === 0, pushed, failed, status: lastStatus };
}

// OUR aggregation rule: sum each player's per-event cascade points across the
// series, scored from THIS room's picks only. Kept here so it can change
// (weighting, drop-lowest, bonuses) without touching the host. Standard
// competition ranking (ties share a rank; the next rank skips).
async function standingForRoom(
  room: RoomRecord,
  eventRefs: string[],
  results: Map<string, ResultDef>,
): Promise<Array<{ playerId: string; points: number; placement: number }>> {
  const totals = new Map<string, number>();
  for (const ref of eventRefs) {
    const result = results.get(ref);
    if (!result) continue;
    for (const row of scorePicks(result, await listPicks(room.roomId, ref))) {
      totals.set(row.playerId, (totals.get(row.playerId) ?? 0) + row.points);
    }
  }

  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  const standing: Array<{ playerId: string; points: number; placement: number }> = [];
  let placement = 0,
    prev = Number.POSITIVE_INFINITY,
    seen = 0;
  for (const [playerId, points] of ranked) {
    seen++;
    if (points < prev) {
      placement = seen;
      prev = points;
    }
    standing.push({ playerId, points, placement });
  }
  return standing;
}
