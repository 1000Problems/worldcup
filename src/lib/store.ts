// ---------------------------------------------------------------------------
// Durable room state — picks, launch context, and the posted result.
//
// Neon Postgres when DATABASE_URL is set; an in-memory fallback otherwise (local
// dev / no DB). Picks and results MUST survive a serverless cold start — a lost
// pick is a missing trophy at /close, so in-memory alone is not production-safe.
//
// We share the 1000Problems Neon instance, so every table here is namespaced
// `worldcup_*` to avoid colliding with the host's `rooms_*` tables. Tables are
// created idempotently on first use (`create table if not exists`) — additive,
// never destructive; this file never drops or migrates anything else.
// ---------------------------------------------------------------------------

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Pick, PlayerPick, ResultDef, LaunchCtx, Outcome } from "@/lib/rooms";

let _sql: NeonQueryFunction<false, false> | null | undefined;
function db(): NeonQueryFunction<false, false> | null {
  if (_sql === undefined) {
    const url = process.env.DATABASE_URL;
    _sql = url ? neon(url) : null;
  }
  return _sql;
}

// ---- in-memory fallback (no DATABASE_URL) ----
const memPicks = new Map<string, Map<string, Pick>>();
const memCtx = new Map<string, LaunchCtx>();
const memResults = new Map<string, ResultDef>();

// ---- schema (idempotent, lazy) ----
let ensured = false;
async function ensure(sql: NeonQueryFunction<false, false>): Promise<void> {
  if (ensured) return;
  await sql`create table if not exists worldcup_pick (
    ref text not null,
    player_id text not null,
    pick jsonb not null,
    room_id text,
    rooms_host text,
    created_at timestamptz not null default now(),
    primary key (ref, player_id)
  )`;
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

export async function savePick(ref: string, playerId: string, pick: Pick, ctx?: LaunchCtx): Promise<void> {
  const sql = db();
  if (!sql) {
    let m = memPicks.get(ref);
    if (!m) memPicks.set(ref, (m = new Map()));
    m.set(playerId, pick);
    if (ctx?.roomId && ctx.roomsHost) memCtx.set(ref, ctx);
    return;
  }
  await ensure(sql);
  await sql`insert into worldcup_pick (ref, player_id, pick, room_id, rooms_host)
    values (${ref}, ${playerId}, ${JSON.stringify(pick)}::jsonb, ${ctx?.roomId ?? null}, ${ctx?.roomsHost ?? null})
    on conflict (ref, player_id) do update set
      pick = excluded.pick,
      room_id = coalesce(excluded.room_id, worldcup_pick.room_id),
      rooms_host = coalesce(excluded.rooms_host, worldcup_pick.rooms_host),
      created_at = now()`;
}

export async function loadPicks(ref: string): Promise<PlayerPick[]> {
  const sql = db();
  if (!sql) {
    const m = memPicks.get(ref);
    return m ? Array.from(m, ([playerId, pick]) => ({ playerId, pick })) : [];
  }
  await ensure(sql);
  const rows = await sql`select player_id, pick from worldcup_pick where ref = ${ref}`;
  return rows.map((r: Record<string, unknown>) => ({ playerId: r.player_id as string, pick: r.pick as Pick }));
}

export async function loadCtx(ref: string): Promise<LaunchCtx | null> {
  const sql = db();
  if (!sql) return memCtx.get(ref) ?? null;
  await ensure(sql);
  const rows = await sql`select room_id, rooms_host from worldcup_pick
    where ref = ${ref} and room_id is not null and rooms_host is not null limit 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? { roomId: r.room_id as string, roomsHost: r.rooms_host as string } : null;
}

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

export async function clear(ref: string): Promise<void> {
  const sql = db();
  if (!sql) {
    memPicks.delete(ref);
    memCtx.delete(ref);
    memResults.delete(ref);
    return;
  }
  await ensure(sql);
  await sql`delete from worldcup_pick where ref = ${ref}`;
  await sql`delete from worldcup_result where ref = ${ref}`;
}
