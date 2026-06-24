# TASK: Private rooms — partition play by roomId, share schedule by sref

> Support PickCity private games: advertise the capability in `/contract`, treat any
> unknown `roomId` that launches in as a fresh isolated room, and fan `/close` out
> once per room. Picks/leaderboard/winner partition by `roomId`; schedule, lock
> times, and results stay shared. Implements the game-side half of
> `GAME-INTEGRATION-PRIVATE.md` (updated spec — no provision endpoint).

## Context

Today every player-facing thing is keyed by event `ref` (`worldcup_pick` PK is
`(ref, player_id)`; the leaderboard, launch context, and `/close` push are all
per-ref). The model assumes one room per ref. `GAME-INTEGRATION-PRIVATE.md` asks
for the opposite split: a private game is just another `roomId` over the same
game, so picks/leaderboard/winner must partition by `roomId`, while events,
`expectedLockAt`, and real-world results stay shared. The pure scorer does not
move — private rooms are a partitioning problem, not a scoring one.

**The updated spec has no creation-time handshake.** PickCity creates the private
room on its side and never calls us; we discover a room the first time one of its
members launches in. The only signal we publish is a `allowsPrivate: true` flag in
`/contract`, which is what makes PickCity show the "Create private game" button.
Discovery is therefore lazy: an unknown `roomId` auto-creates an isolated room.

The launch token and 6h session already carry `roomId` (`RoomsPlayer.roomId`,
`roomSession.ts`), and `/pick` already reads `player.roomId`, so per-room identity
already arrives — it's just not used as a storage key yet. Results keyed by `ref`
already match "shared across rooms", so lock/resolve lockstep is free.

## Requirements

1. **Advertise the capability.** `/contract` returns `allowsPrivate: true`. This
   is the only handshake — no new endpoint.
2. **Room registry.** A new `worldcup_room` table is the authority on which rooms
   exist over which series. The public room is stored as a row too, so fan-out
   treats public and private uniformly.
3. **Picks partitioned by room + lazy auto-create.** `worldcup_pick` is re-keyed
   to `(room_id, ref, player_id)`; `/pick` files under the launching player's
   `roomId` and lazily registers any unseen `roomId` as an isolated room
   (idempotent — a repeat launch/pick is a no-op). Existing match-38 picks are
   backfilled into the public room (see Implementation Notes — backfill).
4. **`/close` fan-out.** On every event and series resolution, push one signed
   `/close` per room over that series — public plus each private room — each
   carrying its own `roomId` and a board computed from that room's own picks.

## Implementation Notes

### Schema (`src/lib/store.ts`, idempotent `create table if not exists`)

New table — keep the `worldcup_` namespace:

```sql
create table if not exists worldcup_room (
  room_id text primary key,
  sref text not null,
  kind text not null default 'private',   -- 'public' | 'private'
  display_name text,
  rooms_host text,
  created_at timestamptz not null default now()
);
```

Re-key picks. The current PK is `(ref, player_id)`; it must become
`(room_id, ref, player_id)` with `room_id` NOT NULL. Postgres can't repoint a PK
in place cleanly, so create the new shape under a fresh definition and migrate:

```sql
create table if not exists worldcup_pick (
  room_id text not null,
  ref text not null,
  player_id text not null,
  pick jsonb not null,
  rooms_host text,
  created_at timestamptz not null default now(),
  primary key (room_id, ref, player_id)
);
```

(`rooms_host` now also lives on `worldcup_room`; keep it on the pick row only if
convenient — the room table is the source of truth for fan-out.)

### Backfill (default — confirm before running in prod)

Existing match-38 picks were written under the old `(ref, player_id)` key with a
nullable `room_id`. Backfill them into the **public** room: insert a
`worldcup_room` row for the harvested public `roomId` (the one already on those
pick rows) with `kind='public'`, then ensure every legacy pick carries that
`room_id`. If a clean-slate cutover is preferred instead, skip the backfill and
let the public room re-register on the next pick — **ask Angel before deleting any
picks.**

### Storage layer (`src/lib/store.ts`)

- Thread `roomId` through `savePick(roomId, ref, playerId, pick, ctx)`,
  `loadPicks(roomId, ref)`, and `clear(roomId, ref)`.
- Add `registerRoom({ roomId, sref, kind, displayName, roomsHost })` (idempotent
  upsert), `getRoom(roomId)`, and `listRoomsForSeries(sref)`.
- `loadCtx` collapses into `getRoom` (roomsHost now comes from the room table, not
  from scanning pick rows).
- Keep the in-memory fallback paths working — mirror every new query with a Map.

### `src/lib/rooms.ts`

- `recordPick`, `listPicks`, `launchCtx` gain a `roomId` parameter and delegate to
  the re-keyed store functions. Re-export `registerRoom` / `listRoomsForSeries`.
- **Do not touch `scorePicks`, the band constants, `validatePick`, `phaseFor`,
  `seriesPhase`, or the result store.** Results stay keyed by `ref`.

### `/contract` (`src/app/contract/route.ts`)

Add one top-level field to the returned manifest: `allowsPrivate: true`. That is
the entire handshake — it's what makes PickCity render the "Create private game"
button. The existing `series: { ref: "world-cup-2026", aggregation: "sum" }` field
already satisfies the spec's `series.ref`; leave it. No new endpoint, no signing.

### `/pick` — lazy room creation (`src/app/pick/route.ts`)

This is now the **only** place a room comes into existence (there is no
provision call). File the pick under `player.roomId`, and before/at the first write
for a `roomId` we haven't seen, `registerRoom` it (idempotent upsert) using
`player.roomId` + `roomsHost` derived from `returnUrl` origin (the derivation
already exists here). Classify `kind`: the room whose `roomId` matches the public
launch is `'public'`; everything else is `'private'`. Simplest reliable rule —
seed/register the public room's `roomId` once (config or first-seen-wins on the
canonical launch) and treat every other `roomId` as private. Confirm the
public-room identity source with Angel if it isn't obvious from the launch token.

A room where members launched but nobody has picked yet has an empty board, so
registering at first pick (rather than at launch) is sufficient for correct
fan-out — an empty room has nothing to close.

`trophyLabel` from the spec is display-only and PickCity-owned — do not store or
echo it.

### `/close` fan-out (`src/lib/roomsClose.ts`)

`pushClose(result)` and `pushSeriesClose(sref)` currently resolve one ctx and push
once. Wrap the existing body in a loop over `listRoomsForSeries(sref)` (include the
public room — it's a row now):

- per room, compute the board from **that room's** picks (`listPicks(roomId, ref)`),
- `post(...)` once per room with that room's `roomId` and `roomsHost`,
- keep the exact same HMAC-over-raw-body signing and the same `playerId` pseudonyms.

`toResults` and the ranking logic stay pure and unchanged — only their pick input
is now room-scoped. `/admin/resolve` already calls both functions and inherits the
fan-out for free.

## Do Not Change

- `scorePicks` and the cascade constants (`W_OUTCOME`, `SCORE_CAP`, `TIMING_CAP`)
  in `src/lib/rooms.ts` — the scorer must stay pure; Rooms re-runs `/score` to
  audit. Re-keying picks must not alter a single point value.
- `src/app/score/route.ts` — pure, IO-free, untouched.
- The result store (`worldcup_result`, `saveResult`/`loadResult`/`setResult`) and
  `phaseFor` / `seriesPhase` — results and lock/resolve stay keyed by `ref`.
- The `/state` signature scheme and `roomsAuth` / `roomSession` / `middleware`
  auth path — `roomId` is already in the session; just consume it.
- **Chat and presence** (`src/app/chat/**`, `src/app/presence/**`,
  `chat_message`, presence tables) — partitioning banter by `roomId` is a
  deliberate follow-up TASK, out of scope here. Leave them keyed by `ref`.
- Do not rename `roomId`/`playerId`/`sref` on the wire or change the `X-Rooms-*`
  signing you already implement.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] `GET /contract` returns `allowsPrivate: true` and still returns valid JSON
      with the existing `series.ref`.
- [ ] An unknown `roomId` arriving via `/pick` auto-creates exactly one
      `worldcup_room` row (`kind='private'`); a repeat pick under the same
      `roomId` creates no duplicate.
- [ ] Two players launched under different `roomId`s over the same game who make
      identical picks land on **separate** leaderboards; resolving the event pushes
      a `/close` to **each** room with its own `roomId`.
- [ ] A `/score` call on the same picks returns byte-identical points before and
      after this change (scorer purity preserved).
- [ ] Existing match-38 picks still score and appear under the public room after
      backfill (or, if clean-slate was chosen with Angel's sign-off, the public
      room re-registers cleanly on next pick).
- [ ] `git diff` touches only: `src/lib/store.ts`, `src/lib/rooms.ts`,
      `src/lib/roomsClose.ts`, `src/app/pick/route.ts`, and
      `src/app/contract/route.ts`. No chat/presence/scorer files; no new endpoint.

## Verification

1. `npm run build`, then `npm run lint`.
2. Curl `/contract` → confirm `allowsPrivate: true` in the JSON. Record a pick
   under a fresh `roomId` twice → exactly one `worldcup_room` row, no duplicate.
3. Simulate two rooms: record picks under two `roomId`s, post a result via
   `/admin/resolve`, confirm two distinct `/close` POSTs (capture with a local
   sink or log the bodies) each carrying the right `roomId` and only that room's
   board.
4. Purity diff: run `/score` on a fixed `{result, picks}` twice and `diff` — must
   be identical.
5. `git diff --stat` — confirm scope matches the Do Not Change list.
