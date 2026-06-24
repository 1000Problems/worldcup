# TASK: Presence rails + "Hello {name}" from Pick City identity

> Build the lobby and per-match presence rosters and the greeting described in
> DESIGN-presence.md. A verified Pick City player who enters GoalRush is greeted by
> name, sees a left rail of everyone in the room, and — once inside a match — a rail of
> everyone in that match. A cumulative "ever played" count proves activity. Picks are
> never exposed.

## Context

Identity already arrives verified: the launch token carries `displayName` +
`avatarToken`, `roomsAuth.ts` verifies it, and `getChatSession()` returns the full
`RoomsPlayer` server-side. Presence today is `chat_presence` — count-only, match-only,
written only when chat opens. This task generalizes presence to carry names at two
scopes (lobby + match), registers it on entry, and renders the two rails + greeting.
Read DESIGN-presence.md first; it is the source of truth for shape and decisions.

## Requirements

1. **Presence table.** Add to the schema in `src/lib/db.ts` (idempotent, alongside the
   chat tables):

   ```sql
   create table if not exists presence (
     scope        text not null,            -- 'series' | 'match'
     scope_id     text not null,
     player_id    text not null,
     display_name text not null,
     avatar_token text,
     first_seen   timestamptz not null default now(),
     last_seen    timestamptz not null default now(),
     primary key (scope, scope_id, player_id)
   );
   create index if not exists presence_scope_seen on presence (scope, scope_id, last_seen);
   ```

2. **`seriesForEvent(ref)` in `src/lib/rooms.ts`.** Resolve a match ref to its series
   ref via the existing `SERIES` registry; fall back to the single pilot series. Used
   by the beat to write the lobby row.

3. **`POST /presence/beat` `{ matchRef?: string }`.** Identity from `getChatSession()`
   only — ignore any identity in the body. No session → `200 { ok: false }`, write
   nothing. With a session: upsert the `series` row (scope_id = `seriesForEvent(matchRef)`
   or the pilot series when no `matchRef`); if `matchRef` present, also upsert the
   `match` row (scope_id = `matchRef`). Upserts set `last_seen = now()` and **must not**
   touch `first_seen` on conflict.

4. **`GET /presence?scope=…&id=…`.** Return
   `{ online: [{ playerId, name, avatar, since }], onlineCount, everCount }`.
   `online` = distinct players with `last_seen > now() - interval '45 seconds'`, most
   recent first, capped at 50. `onlineCount` = the full distinct online count.
   `everCount` = distinct `player_id` for that scope/id all-time. **The response must
   never include any pick field.**

5. **Heartbeat hook + rail (client).** Add `useHeartbeat(matchRef?)` (beat on mount +
   every ~15s, paused on `document.visibilitychange` hidden) and a `PresenceRail`
   driven by a `usePresence(scope, id)` poll (~5s, visibility-paused). Rail shows
   avatar + name per online player, the `everCount` badge ("N have played"), and an
   empty state ("Be the first one in") — never a fabricated count.

6. **Greeting + wiring.**
   - `page.tsx`: pass `displayName` + `avatarToken` into `Landing`.
   - `Landing`: render "Hello, {name}" and mount `PresenceRail scope="series"`
     id=pilot-series, as a left column on wide / collapsible strip on narrow.
   - `RoomClient`: mount `PresenceRail scope="match" id={ref}`; send the heartbeat with
     `matchRef = ref`.
   - Dev stub (`?name=`): greet "Hello, {name} · guest", show the rails, but never
     register or count (it has no session, so the beat already no-ops — just don't fake
     a row client-side).

7. **Unify the chat online indicator.** Point `GET /chat/{ref}`'s online count at the
   `presence` `match` rows and retire the separate `POST /chat/{ref}/ping` (RoomClient
   now sends one presence beat covering both scopes). This is the one allowed edit to
   chat files; keep it surgical.

## Implementation Notes

- **Files:** new `src/app/presence/beat/route.ts`, `src/app/presence/route.ts`, a
  `PresenceRail.tsx` + hooks (colocate or in `src/app/`); edits to `src/lib/db.ts`,
  `src/lib/rooms.ts`, `src/app/page.tsx`, `src/app/RoomClient.tsx`, `src/app/globals.css`,
  and the two chat files for req. 7. No new dependencies.
- **Design language:** reuse the `GR` palette + Oswald treatment already in `page.tsx`
  / `RoomClient`. The rail should read as part of GoalRush, not a bolt-on.
- **Style of presence:** mirror the chat poll's visibility-pause and cursor discipline;
  don't introduce a second polling cadence pattern.
- **Secrets:** none added. `DATABASE_URL` and `ROOMS_SIGNING_KEY` are the only env vars
  involved and already exist — reference by name, never inline a value.

## Do Not Change

- The pick schema, `/score` and the pure scorer, `/validate`, `/resolve`, `/rewards`,
  `/admin/*`, `roomsAuth.ts`, `roomSession.ts`, `middleware.ts`, the series routes.
- Chat message + reaction endpoints and their schema — only the online-count source and
  the now-retired ping are in scope (req. 7).
- `first_seen` semantics — it is write-once per (scope, scope_id, player). Never reset it.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] Two real-token sessions on `/?ref=match-38` see each other in the match rail
      within a poll, and both appear in the lobby rail at `/`.
- [ ] `Landing` and `RoomClient` greet the verified player by name.
- [ ] `everCount` increments on a player's first entry only, not on every beat.
- [ ] A `?name=Dev` tab sees the rails but never appears in them and never bumps any
      count.
- [ ] No pick data appears in any `/presence` response.
- [ ] The chat online count reflects `presence`; no second ping path remains.

## Verification

1. `npm run build`.
2. Two tabs on `/?ref=match-38` (one valid token, one `?name=Dev`): confirm the valid
   one shows in both rails, the dev one in neither; beat a few cycles and confirm
   `everCount` holds steady while `onlineCount` tracks who's focused.
3. `curl` `GET /presence?scope=series&id=<pilot>` and `…scope=match&id=match-38`; assert
   the JSON has only name/avatar/since — `git grep` the response builder for any `pick`
   reference and confirm none.
4. `git diff --stat` shows chat edits limited to the online-count source + ping removal.
