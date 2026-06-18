# TASK: Banter Box chat backend (Neon Postgres)

> Add a real, persistent per-match chat: a Neon Postgres store, cookie-based
> identity derived from the verified Rooms token, and polling endpoints for
> messages, reactions, and presence. No UI in this task.

## Context

The redesign introduces a live "Banter Box" chat. The prototype fakes it
entirely (local bot replies, hardcoded "6 online"). Angel wants it real and
durable, backed by an existing Neon Postgres database. The project is otherwise
DB-less and runs on Vercel serverless, so chat needs a store plus a transport.
This task builds the backend; `TASK-banter-box-ui.md` consumes it. Vercel
serverless can't hold push sockets cheaply, so the transport is **client
polling** of a `since`-cursor endpoint; LISTEN/NOTIFY or SSE is a later upgrade.

## Requirements

1. **Schema + DB client.** Connect to Neon via the `@neondatabase/serverless`
   HTTP driver using `process.env.DATABASE_URL`. Create a `src/lib/db.ts` and an
   idempotent migration (a `chat_message`, `chat_reaction`, and `chat_presence`
   table — shapes below). Index for the polling read path.
2. **Identity via signed cookie.** Add `middleware.ts` that, when the room is
   launched with `?t=<token>`, verifies it with the existing Rooms HS256 logic,
   mints a short-lived HttpOnly+Secure session cookie (`playerId`, `displayName`,
   `ref`, `exp`) signed with `ROOMS_SIGNING_KEY`, and redirects to strip the
   token from the URL. Add `src/lib/chatSession.ts` to mint/verify that cookie.
   No verified cookie ⇒ read-only (dev stub may read, cannot post).
3. **Read endpoint.** `GET /chat/{ref}?since={id}` → `{ messages[], reactions{},
   presence: { online } }`, returning only messages with `id > since` plus the
   reaction state for the visible window and the current online count.
4. **Write endpoints.** `POST /chat/{ref}` `{ body }` inserts a message as the
   cookie's player (reject if no valid cookie, empty/oversized body, or wrong
   ref). `POST /chat/{ref}/react` `{ messageId, emoji }` toggles the player's
   reaction. Both return the new row/state.
5. **Presence heartbeat.** `POST /chat/{ref}/ping` upserts `chat_presence`
   (`player_id`, `last_seen=now()`); "online" = distinct players with
   `last_seen > now() - interval '30 seconds'`.

## Implementation Notes

- **Secrets:** read the connection string from `DATABASE_URL` only — never
  inline it, never commit it. Add it to Vercel env and a gitignored
  `.env.local`. Add `DATABASE_URL` to the env table in `CLAUDE.md`.
- **Reuse, don't fork, auth.** The HS256 verify already lives in
  `src/lib/roomsAuth.ts` (`verifyRoomsSession`). `chatSession.ts` should reuse
  the same `ROOMS_SIGNING_KEY` and the same constant-time-compare discipline;
  do not invent a second signing scheme.
- **Suggested schema (adjust types as needed):**
  ```sql
  create table if not exists chat_message (
    id           bigserial primary key,
    match_ref    text        not null,
    player_id    text        not null,
    display_name text        not null,
    body         text        not null check (char_length(body) <= 500),
    created_at   timestamptz not null default now()
  );
  create index if not exists chat_message_ref_id on chat_message (match_ref, id);

  create table if not exists chat_reaction (
    message_id bigint not null references chat_message(id) on delete cascade,
    player_id  text   not null,
    emoji      text   not null,
    primary key (message_id, player_id, emoji)
  );

  create table if not exists chat_presence (
    match_ref text not null,
    player_id text not null,
    last_seen timestamptz not null default now(),
    primary key (match_ref, player_id)
  );
  ```
- **Route placement:** handlers live at root paths Rooms-style (`/chat/...`),
  consistent with the existing `/score`, `/phase` convention — not under `/api`.
- **CORS/iframe:** match the existing per-route OPTIONS + `Access-Control-Allow-
  Origin` pattern in `src/lib/http.ts` so the iframe can call these.
- **Server-trusted identity only.** The poster's `player_id`/`display_name` come
  from the verified cookie server-side, never from the request body — a client
  must not be able to post as someone else.

## Do Not Change

- `src/lib/rooms.ts`, `src/lib/roomsAuth.ts` (verify logic) — reuse, don't edit
  the verify path; only import from it.
- The existing pick/score/phase/resolve/admin route handlers — chat is additive.
- `RoomClient.tsx` — UI wiring is the next task; this one ships no UI.

## Acceptance Criteria

- [ ] `npm run build` passes with zero errors; `@neondatabase/serverless` is the
      only new dependency.
- [ ] Migration runs idempotently (safe to run twice).
- [ ] With a valid launch token, the session cookie is set and the token is
      stripped from the URL; without one, POST `/chat/{ref}` is rejected 401/403.
- [ ] `POST /chat/match-38` then `GET /chat/match-38?since=0` returns the message
      with server-trusted `player_id`; a forged body `player_id` is ignored.
- [ ] React toggle adds then removes the caller's reaction; presence count
      reflects recent `ping`s and decays after 30s.
- [ ] `DATABASE_URL` documented in `CLAUDE.md`; no secret literals in the diff.

## Verification

1. `npm run build`; run the migration twice and confirm no error.
2. Curl the read/write/react/ping endpoints against Neon with and without a
   valid cookie; confirm rejection paths.
3. `git grep -nE "postgres://|neondb_owner|npg_"` returns nothing (no leaked
   secret).
4. `git diff --stat` — changes only in new chat files, `db.ts`, `chatSession.ts`,
   `middleware.ts`, `http.ts` (if OPTIONS added), and `CLAUDE.md`.
