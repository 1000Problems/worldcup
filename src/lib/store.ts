// ---------------------------------------------------------------------------
// Durable room state — rooms, picks, and the posted result.
//
// Neon Postgres when DATABASE_URL is set; an in-memory fallback otherwise (local
// dev / no DB). Picks and results MUST survive a serverless cold start — a lost
// pick is a missing trophy at /close, so in-memory alone is not production-safe.
//
// PARTITIONING (private rooms): picks are keyed by (room_id, ref, player_id) so a
// private game — just another roomId over the same schedule — keeps an isolated
// leaderboard. Results stay keyed by ref alone (shared across every room playing
// that event), so lock/resolve happen in lockstep for free. The worldcup_room
// table is the authority on which rooms exist over which series (sref).
//
// We share the 1000Problems Neon instance, so every table here is namespaced
// `worldcup_*` to avoid colliding with the host's `rooms_*` tables. Tables are
// created idempotently on first use (`create table if not exists`) — additive,
// never destructive; this file never drops or migrates the host's data.
// ---------------------------------------------------------------------------

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Pick, PlayerPick, ResultDef, RoomRecord, RoomKind, Outcome } from "@/lib/rooms";

let _sql: NeonQueryFunction<false, false> | null | undefined;
function db(): NeonQueryFunction<false, false> | null {
  if (_sql === undefined) {
    const url = process.env.DATABASE_URL;
    _sql = url ? neon(url) : null;
  }
  return _sql;
}

// ---- in-memory fallback (no DATABASE_URL) ----
const SEP = " "; // room_id ∥ ref composite key separator
const memPicks = new Map<string, Map<string, Pick>>(); // `${roomId}${SEP}${ref}` → playerId → pick
const memRooms = new Map<string, RoomRecord>(); // roomId → room
const memResults = new Map<string, ResultDef>(); // ref → result
const pk = (roomId: string, ref: string) => `${roomId}${SEP}${ref}`;

// ---- schema (idempotent, lazy) ----
let ensured = false;
async function ensure(sql: NeonQueryFunction<false, false>): Promise<void> {
  if (ensured) return;

  await sql`create table if not exists worldcup_room (
    room_id text primary key,
    sref text not null,
    kind text not null default 'private',
    display_name text,
    rooms_host text,
    created_at timestamptz not null default now()
  )`;

  await sql`create table if not exists worldcup_pick (
    room_id text not null,
    ref text not null,
    player_id text not null,
    pick jsonb not null,
    rooms_host text,
    created_at timestamptz not null default now(),
    primary key (room_id, ref, player_id)
  )`;

  // Migrate a pre-private-rooms table (PK was (ref, player_id), room_id nullable)
  // forward in place. Each step is guarded, so this is a no-op on a fresh table.
  await sql`alter table worldcup_pick add column if not exists room_id text`;
  await sql`alter table worldcup_pick add column if not exists rooms_host text`;
  await sql`update worldcup_pick set room_id = 'legacy-unknown' where room_id is null`;
  await sql`alter table worldcup_pick drop constraint if exists worldcup_pick_pkey`;
  await sql`alter table worldcup_pick add primary key (room_id, ref, player_id)`;

  await sql`create table if not exists worldcup_result (
    ref text primary key,
    home_goals int not null,
    away_goals int not null,
    outcome text not null,
    home_minutes jsonb not null,
    away_minutes jsonb not null,
    created_at timestamptz not null default now()
  )`;
  ensured = true;
}

// ---- rooms ----------------------------------------------------------------

export async function registerRoom(room: RoomRecord): Promise<void> {
  const sql = db();
  if (!sql) {
    if (!memRooms.has(room.roomId)) memRooms.set(room.roomId, room);
    return;
  }
  await ensure(sql);
  // Idempotent: a repeat roomId is a no-op (first registration wins kind/host).
  await sql`insert into worldcup_room (room_id, sref, kind, display_name, rooms_host)
    values (${room.roomId}, ${room.sref}, ${room.kind},
            ${room.displayName ?? null}, ${room.roomsHost ?? null})
    on conflict (room_id) do nothing`;
}

export async function getRoom(roomId: string): Promise<RoomRecord | null> {
  const sql = db();
  if (!sql) return memRooms.get(roomId) ?? null;
  await ensure(sql);
  const rows = await sql`select room_id, sref, kind, display_name, rooms_host
    from worldcup_room where room_id = ${roomId}`;
  return rows[0] ? rowToRoom(rows[0] as Record<string, unknown>) : null;
}

export async function listRoomsForSeries(sref: string): Promise<RoomRecord[]> {
  const sql = db();
  if (!sql) return Array.from(memRooms.values()).filter((r) => r.sref === sref);
  await ensure(sql);
  const rows = await sql`select room_id, sref, kind, display_name, rooms_host
    from worldcup_room where sref = ${sref}`;
  return rows.map((r: Record<string, unknown>) => rowToRoom(r));
}

// Legacy picks carry a room_id but predate the worldcup_room registry. Surface
// the distinct (room_id, ref) pairs with no room row yet so rooms.ts can register
// them as the public room (it owns the ref→series mapping; store stays agnostic).
export async function listUnregisteredPickRooms(): Promise<
  { roomId: string; ref: string; roomsHost: string | null }[]
> {
  const sql = db();
  if (!sql) {
    const out: { roomId: string; ref: string; roomsHost: string | null }[] = [];
    for (const key of Array.from(memPicks.keys())) {
      const [roomId, ref] = key.split(SEP);
      if (roomId && roomId !== "legacy-unknown" && !memRooms.has(roomId)) {
        out.push({ roomId, ref, roomsHost: null });
      }
    }
    return out;
  }
  await ensure(sql);
  const rows = await sql`select distinct p.room_id, p.ref, p.rooms_host
    from worldcup_pick p
    left join worldcup_room r on r.room_id = p.room_id
    where r.room_id is null and p.room_id <> 'legacy-unknown'`;
  return rows.map((r: Record<string, unknown>) => ({
    roomId: r.room_id as string,
    ref: r.ref as string,
    roomsHost: (r.rooms_host as string | null) ?? null,
  }));
}

function rowToRoom(r: Record<string, unknown>): RoomRecord {
  return {
    roomId: r.room_id as string,
    sref: r.sref as string,
    kind: r.kind as RoomKind,
    displayName: (r.display_name as string | null) ?? undefined,
    roomsHost: (r.rooms_host as string | null) ?? undefined,
  };
}

// ---- picks (partitioned by room) ------------------------------------------

export async function savePick(
  roomId: string,
  ref: string,
  playerId: string,
  pick: Pick,
  roomsHost?: string,
): Promise<void> {
  const sql = db();
  if (!sql) {
    let m = memPicks.get(pk(roomId, ref));
    if (!m) memPicks.set(pk(roomId, ref), (m = new Map()));
    m.set(playerId, pick);
    return;
  }
  await ensure(sql);
  await sql`insert into worldcup_pick (room_id, ref, player_id, pick, rooms_host)
    values (${roomId}, ${ref}, ${playerId}, ${JSON.stringify(pick)}::jsonb, ${roomsHost ?? null})
    on conflict (room_id, ref, player_id) do update set
      pick = excluded.pick,
      rooms_host = coalesce(excluded.rooms_host, worldcup_pick.rooms_host),
      created_at = now()`;
}

export async function loadPicks(roomId: string, ref: string): Promise<PlayerPick[]> {
  const sql = db();
  if (!sql) {
    const m = memPicks.get(pk(roomId, ref));
    return m ? Array.from(m, ([playerId, pick]) => ({ playerId, pick })) : [];
  }
  await ensure(sql);
  const rows = await sql`select player_id, pick from worldcup_pick
    where room_id = ${roomId} and ref = ${ref}`;
  return rows.map((r: Record<string, unknown>) => ({ playerId: r.player_id as string, pick: r.pick as Pick }));
}

// ---- results (shared across rooms, keyed by ref) --------------------------

export async function saveResult(r: ResultDef): Promise<void> {
  const sql = db();
  if (!sql) {
    memResults.set(r.ref, r);
    return;
  }
  await ensure(sql);
  await sql`insert into worldcup_result (ref, home_goals, away_goals, outcome, home_minutes, away_minutes)
    values (${r.ref}, ${r.homeGoals}, ${r.awayGoals}, ${r.outcome},
            ${JSON.stringify(r.homeGoalMinutes)}::jsonb, ${JSON.stringify(r.awayGoalMinutes)}::jsonb)
    on conflict (ref) do update set
      home_goals = excluded.home_goals, away_goals = excluded.away_goals,
      outcome = excluded.outcome, home_minutes = excluded.home_minutes,
      away_minutes = excluded.away_minutes, created_at = now()`;
}

export async function loadResult(ref: string): Promise<ResultDef | null> {
  const sql = db();
  if (!sql) return memResults.get(ref) ?? null;
  await ensure(sql);
  const rows = await sql`select * from worldcup_result where ref = ${ref}`;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    ref: r.ref as string,
    homeGoals: r.home_goals as number,
    awayGoals: r.away_goals as number,
    outcome: r.outcome as Outcome,
    homeGoalMinutes: r.home_minutes as number[],
    awayGoalMinutes: r.away_minutes as number[],
    final: true,
  };
}

// Wipe OUR state for a ref (dev /admin/reset): every room's picks for that event,
// plus the result. Rooms registry is left intact — rooms outlive a single event.
export async function clear(ref: string): Promise<void> {
  const sql = db();
  if (!sql) {
    for (const key of Array.from(memPicks.keys())) {
      if (key.split(SEP)[1] === ref) memPicks.delete(key);
    }
    memResults.delete(ref);
    return;
  }
  await ensure(sql);
  await sql`delete from worldcup_pick where ref = ${ref}`;
  await sql`delete from worldcup_result where ref = ${ref}`;
}
