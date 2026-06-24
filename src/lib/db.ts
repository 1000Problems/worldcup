// ---------------------------------------------------------------------------
// Neon Postgres — the durable store for Banter Box chat.
//
// The rest of the room is DB-less (Rooms owns the durable pick store, and our
// result store is in-memory). Chat is the one thing we want to survive a cold
// start, so it lives in Neon, reached over the HTTP serverless driver.
//
// SECURITY: the connection string comes from DATABASE_URL only — never inline a
// credential, never commit one. Set it in Vercel env + a gitignored .env.local.
// ---------------------------------------------------------------------------

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

// Lazy so `next build` (which never hits a request) doesn't need DATABASE_URL.
export function sql(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _sql = neon(url);
  return _sql;
}

// Run once per cold start. Idempotent — safe to call on every chat request.
let _schemaReady: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  const db = sql();
  _schemaReady = (async () => {
    // One HTTP round trip for all DDL (Neon batches the array as a single request),
    // instead of six sequential trips gating the first read on every cold start.
    // Order matters: chat_reaction references chat_message, so the table precedes it.
    await db.transaction([
      db`
      create table if not exists chat_message (
        id           bigserial primary key,
        match_ref    text        not null,
        player_id    text        not null,
        display_name text        not null,
        body         text        not null check (char_length(body) <= 500),
        created_at   timestamptz not null default now()
      )`,
      db`create index if not exists chat_message_ref_id on chat_message (match_ref, id)`,
      db`
      create table if not exists chat_reaction (
        message_id bigint not null references chat_message(id) on delete cascade,
        player_id  text   not null,
        emoji      text   not null,
        primary key (message_id, player_id, emoji)
      )`,
      db`
      create table if not exists chat_presence (
        match_ref text not null,
        player_id text not null,
        last_seen timestamptz not null default now(),
        primary key (match_ref, player_id)
      )`,
      // Roster presence — who is in the room (scope='series') and who is in a given
      // match (scope='match'). Carries name + avatar so the lobby/match rails can show
      // people, not just a count. Namespaced `worldcup_*` because this Neon is shared
      // with other 1000Problems services. first_seen is write-once (the cumulative
      // "ever played" anchor); last_seen is bumped every heartbeat (the liveness anchor).
      db`
      create table if not exists worldcup_presence (
        scope        text        not null,
        scope_id     text        not null,
        player_id    text        not null,
        display_name text        not null,
        avatar_token text,
        first_seen   timestamptz not null default now(),
        last_seen    timestamptz not null default now(),
        primary key (scope, scope_id, player_id)
      )`,
      db`create index if not exists worldcup_presence_scope_seen
      on worldcup_presence (scope, scope_id, last_seen)`,
    ]);
  })().catch((e) => {
    // Reset so a transient failure doesn't permanently poison the cache.
    _schemaReady = null;
    throw e;
  });
  return _schemaReady;
}
