// ---------------------------------------------------------------------------
// Roster presence — SERVER ONLY.
//
// Two scopes share one table (worldcup_presence): 'series' is the GoalRush lobby
// (everyone in the room), 'match' is one fixture (everyone in that game). A player
// inside a match owns one row at each scope, so the lobby rail naturally includes
// people who are currently deep in a match.
//
// SECURITY / TRUST:
//   - Identity is the verified session (getChatSession), never the request body —
//     same rule as chat posts. Only a real Pick City session registers presence.
//   - Reads return name + avatar + timestamps only. A pick is NEVER serialized
//     here; presence and the pick store are separate concerns.
// ---------------------------------------------------------------------------

import { sql, ensureSchema } from "@/lib/db";
import { getSeries, seriesForEvent, getMatch, listSeries } from "@/lib/rooms";
import type { RoomsPlayer } from "@/lib/roomsAuth";

// A player is "online" if seen within this window. One missed beat (beats are ~15s)
// still counts as present; two misses drops them.
const ONLINE_WINDOW_SECONDS = 45;
// Cap the live list; onlineCount still reports the true total beyond the cap.
const ONLINE_LIMIT = 50;

export type PresenceScope = "series" | "match";

export interface PresencePerson {
  playerId: string;
  name: string;
  avatar: string | null;
  since: string; // last_seen ISO — drives "active now" ordering on the client
}

export interface PresenceSnapshot {
  online: PresencePerson[];
  onlineCount: number;
  everCount: number;
}

// Resolve the lobby scope_id for a (possibly absent) match: the match's series, or
// the single pilot series when the player is in the lobby with no match selected.
function lobbyScopeId(matchRef?: string | null): string | null {
  if (matchRef) {
    const s = seriesForEvent(matchRef);
    if (s) return s.ref;
  }
  return listSeries()[0]?.ref ?? null;
}

async function upsert(
  scope: PresenceScope,
  scopeId: string,
  p: RoomsPlayer,
): Promise<void> {
  const db = sql();
  await db`
    insert into worldcup_presence (scope, scope_id, player_id, display_name, avatar_token)
    values (${scope}, ${scopeId}, ${p.playerId}, ${p.displayName}, ${p.avatarToken ?? null})
    on conflict (scope, scope_id, player_id) do update set
      last_seen = now(),
      display_name = excluded.display_name,
      avatar_token = excluded.avatar_token`;
}

// Record a heartbeat for the verified player: always the lobby (series) row; the
// match row too when they're inside a match. Returns the scopes actually written.
export async function recordPresence(
  player: RoomsPlayer,
  matchRef?: string | null,
): Promise<{ series: boolean; match: boolean }> {
  await ensureSchema();
  const written = { series: false, match: false };

  const sid = lobbyScopeId(matchRef);
  if (sid && getSeries(sid)) {
    await upsert("series", sid, player);
    written.series = true;
  }
  // Only register a match row for a real fixture — keeps junk refs out of the table.
  if (matchRef && getMatch(matchRef)) {
    await upsert("match", matchRef, player);
    written.match = true;
  }
  return written;
}

// Roster for one scope: the live list, the true online count, and the cumulative
// "ever entered" count (every row, since the PK is one row per player per scope).
export async function readPresence(scope: PresenceScope, scopeId: string): Promise<PresenceSnapshot> {
  await ensureSchema();
  const db = sql();

  // The roster and the counts are independent reads — fire them concurrently so the
  // rail costs one Neon round trip, not two serialized ones.
  const [rows, counts] = (await Promise.all([
    db`
    select player_id, display_name, avatar_token, last_seen
    from worldcup_presence
    where scope = ${scope} and scope_id = ${scopeId}
      and last_seen > now() - ${`${ONLINE_WINDOW_SECONDS} seconds`}::interval
    order by last_seen desc
    limit ${ONLINE_LIMIT}`,
    db`
    select
      count(*) filter (where last_seen > now() - ${`${ONLINE_WINDOW_SECONDS} seconds`}::interval)::int as online,
      count(*)::int as ever
    from worldcup_presence
    where scope = ${scope} and scope_id = ${scopeId}`,
  ])) as [
    Array<{
      player_id: string;
      display_name: string;
      avatar_token: string | null;
      last_seen: string;
    }>,
    Array<{ online: number; ever: number }>,
  ];

  return {
    online: rows.map((r) => ({
      playerId: r.player_id,
      name: r.display_name,
      avatar: r.avatar_token,
      since: new Date(r.last_seen).toISOString(),
    })),
    onlineCount: counts[0]?.online ?? 0,
    everCount: counts[0]?.ever ?? 0,
  };
}

// Live online count for a single match — the source the chat "N live" pill reads,
// so chat presence and the rail share one truth.
export async function matchOnlineCount(matchRef: string): Promise<number> {
  await ensureSchema();
  const db = sql();
  const rows = (await db`
    select count(*)::int as online from worldcup_presence
    where scope = 'match' and scope_id = ${matchRef}
      and last_seen > now() - ${`${ONLINE_WINDOW_SECONDS} seconds`}::interval`) as Array<{ online: number }>;
  return rows[0]?.online ?? 0;
}
