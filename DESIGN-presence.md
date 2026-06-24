# DESIGN — Presence: lobby + per-match rosters from Pick City identity

Design of record for showing **who is here**. Two left-rail rosters — everyone in the
GoalRush lobby, and everyone inside a given match — plus a "Hello {name}" greeting,
all driven by the verified Pick City (formerly Rooms) launch identity. Planning doc,
not a build task — pin the shape here, then cut TASK-presence-rails.

## The scenario this serves

Land in GoalRush from Pick City → the selector greets **"Hello Angel"** and a left
rail lists everyone currently in the room (picked or not) → click Spain–Uruguay →
the rail narrows to everyone in that match, still **"Hello Angel"** up top. A running
count ("312 have played") proves the room is alive even in a quiet minute. Picks stay
private the whole way — presence shares names and faces, never predictions.

## What exists today (grounded)

- `chat_presence(match_ref, player_id, last_seen)` in Neon, written by `POST
  /chat/{ref}/ping`, read as a bare `count(*)` of the last 30s in `GET /chat/{ref}`.
  It has no names, lives only at match scope, and is only written when a player opens
  a match's chat — not on room entry.
- The launch token already carries `displayName` and `avatarToken`; `roomsAuth.ts`
  verifies it server-side and `getChatSession()` returns the full `RoomsPlayer` from
  the session cookie. **Identity is already in hand on the server — it is not being
  surfaced.**
- `Landing` in `page.tsx` verifies the player but passes only `returnUrl` down, so the
  selector can't greet by name or show a rail. `RoomClient` already receives
  `displayName`.

So the trust model, the store, and a heartbeat primitive all exist. What's missing is
names on presence rows, a second (lobby) scope, registration on entry rather than only
on chat, and the two rails + greeting in the UI.

## Decisions locked

- **Rail = live online + a cumulative badge.** The list shows who's active right now
  (heartbeat window); a separate count shows everyone who has ever entered that scope.
  Live energy plus durable social proof, from one table.
- **Verified only.** Only a real Pick City session registers presence or counts toward
  the activity number. The dev stub (`?name=`) can read the rails but never appears in
  them and never increments a count — no spoofable names, no padding.
- **No seeded/fake presence.** The activity number is real or it's nothing. An empty
  room says "Be the first in," it does not invent bots.

## The model

One table at the finest grain, with an explicit scope so the same row shape serves both
rails:

```sql
create table if not exists presence (
  scope        text        not null,   -- 'series' | 'match'
  scope_id     text        not null,   -- 'world-cup-2026'  |  'match-38'
  player_id    text        not null,
  display_name text        not null,
  avatar_token text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  primary key (scope, scope_id, player_id)
);
create index if not exists presence_scope_seen on presence (scope, scope_id, last_seen);
```

`first_seen` is the cumulative anchor (counted once, on first entry); `last_seen` is the
liveness anchor (bumped every beat). A player inside a match owns two rows — one `series`
row (they are in the room) and one `match` row — so both rails come from one write.

This **supersedes** `chat_presence`: it is the same idea at match scope, now carrying
names and a sibling lobby scope. The chat online indicator should read from `presence`
too, so "who's online in this match" has a single source of truth.

## The heartbeat — one beat, both scopes

While the tab is focused, the client beats on mount and every ~15s, visibility-paused
exactly like the chat poll (don't hammer Neon from a background tab).

```
POST /presence/beat   { matchRef?: string }
```

- Identity comes from the verified session cookie via `getChatSession()`. The body
  carries **no name** — it can't be spoofed, same rule as chat posts.
- No session → `200 { ok: false }`, nothing written. Verified-only, enforced at the
  write.
- With a session: always upsert the `series` row for the pilot series; if `matchRef` is
  present, also upsert the `match` row. Upsert sets `last_seen = now()` and leaves
  `first_seen` untouched on conflict, so the cumulative count never double-counts.
- The series for a match comes from the `SERIES` registry in `lib/rooms.ts`
  (`seriesForEvent(ref)`); the lobby (no match selected) uses the single pilot series,
  `listSeries()[0]`.

This replaces the chat `ping`: RoomClient sends one presence beat covering both scopes
instead of a separate chat ping.

## The reads — two rails, same shape

```
GET /presence?scope=series&id=world-cup-2026   → lobby rail
GET /presence?scope=match&id=match-38          → match rail
```

Both return:

```jsonc
{
  "online":      [{ "playerId": "...", "name": "Angel", "avatar": "...", "since": "..." }],
  "onlineCount": 7,      // distinct players with last_seen inside the ~45s window
  "everCount":   312     // distinct players ever in this scope — the activity proof
}
```

`online` is the live list (ordered most-recent-first, capped — e.g. 50 — with the count
carrying the overflow). `everCount` is the cumulative badge. **The payload only ever
carries name + avatar + timestamps. It never carries a pick** — presence and the pick
store are separate concerns, and the pick-privacy invariant is unaffected.

## The UI

- **`page.tsx`** passes `displayName` + `avatarToken` into `Landing` (today it passes
  only `returnUrl`). One-line plumbing change.
- **`Landing`** gains a "Hello, {name}" header and a left **PresenceRail** bound to
  `scope=series`. The selector is currently a single 720px column; add the rail as a
  left column on wide and a collapsible strip on narrow (the iframe can be slim).
- **`RoomClient`** gains the same PresenceRail bound to `scope=match&id={ref}`, and
  already has the name for its greeting. Its heartbeat sends `matchRef = ref`.
- A shared client **`PresenceRail`** + a `usePresence(scope, id)` poll hook (~5s) + a
  `useHeartbeat(matchRef?)` that beats on mount/interval and pauses when hidden.
- **Greeting fallback.** The dev stub renders "Hello, {name} · guest" and shows the
  rails populated by real players, but is itself never written or counted.
- **Empty state.** Zero online → "Be the first one in." Honest, not padded.

This presence feature is the game's own, rendered on the game's surfaces. It is
independent of the host hub in DESIGN-series.md: whether a player arrives via the Pick
City hub deep-link or our own GoalRush selector, the rails and greeting work the same.

## Cost & lifecycle

One `POST` per 15s per focused tab, two upserts each, visibility-paused — negligible on
Neon's HTTP driver. Liveness is windowed, so no cron is needed to expire "online."
`everCount` grows monotonically by design — that's the point. Pruning old `match` rows
after the tournament is optional housekeeping, not v1.

## What changes where

**worldcup (game):** add the `presence` table to the schema (`lib/db.ts`); add
`seriesForEvent()` to `lib/rooms.ts`; add `POST /presence/beat` and `GET /presence`;
add `PresenceRail` + the two hooks; surface name into `Landing` from `page.tsx`; point
the chat online indicator at `presence` and retire the separate chat `ping`.

**Unchanged:** the pick schema, `/score` and the pure scorer, validation, resolve,
`roomsAuth.ts`, the session/middleware flow, and the series API.

## Open decisions

- **Cross-match identity.** A player's `playerId` is stable across matches (it's the
  Pick City identity), so the lobby rail naturally dedupes someone who has several
  matches open. Confirmed fine; noted so it isn't re-litigated.
- **Idle vs gone.** The 45s window calls a backgrounded tab "offline" within a beat or
  two. Acceptable for v1; revisit if the rail feels twitchy.
- **Rail privacy.** Display names are shared across players by design — that is the
  lobby. If a future private/office-pool series wants hidden rosters, scope visibility
  to membership then; not now.

## Verification

`npm run build` (canonical). Then: two sessions on `/?ref=match-38` see each other in
the match rail within a poll, and both appear in the lobby rail at `/` (no `ref`).
`everCount` increments on first entry only, not on every beat. A `?name=Dev` tab sees
the rails but never appears in them and never bumps a count. `git grep` the `/presence`
response path to confirm no pick field is ever serialized.
