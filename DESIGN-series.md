# DESIGN — World Cup as a series of events

Design of record for turning the worldcup room from one match into a **series** of
matches, starting with two: the existing Spain–Saudi (`match-38`) and a new
Spain–Uruguay. Planning doc, not a build task — pin the shape here, then cut a TASK.

## What exists today (grounded)

- `lib/rooms.ts` holds `MATCHES`, keyed by ref; only `match-38` is seeded.
- The store (`savePick` / `loadResult` / `phaseFor`) is already **per-ref**, so
  multiple matches store and resolve independently with no change.
- Endpoints are per-event: `/contract`, `/event/{ref}`, `/phase/{ref}`,
  `/validate`, `/resolve`, `/score` (pure), `/rewards`, `/admin/*`.
- `page.tsx` (the bespoke renderer at `rendererUrl`) already reads `?ref=` and
  defaults to `match-38`.

So the per-event machinery is done. What's missing is the object that groups events
into a tournament, the endpoints that expose it, and the host hub that navigates it.

## The model (naming locked)

Three levels; the one-room-one-event invariant holds at the bottom:

- **Series** — "FIFA World Cup 2026." One running tournament. Owns the *list* of
  events, a series phase, and a series result (the aggregate standing). New.
- **Event** — one match (`match-38`). Open → locked → completed, one result, one
  pure score. Exists, unchanged.
- **Room** — one instance on one event. Still one room = one event. The series is
  an aggregation over events, never a long-lived room.

A standalone match is just an event with no series declared — nothing branches in
how it's scored. The series only adds the cross-event sum.

---

## Part 1 — How worldcup defines the series and events

Two additive changes in `lib/rooms.ts`. No new infrastructure.

### 1a. Add the second match to `MATCHES`

```ts
"match-54": {
  ref: "match-54",
  competition: "FIFA World Cup 2026",
  stage: "Group H · Matchday 3",
  home: { code: "ESP", name: "Spain" },
  away: { code: "URU", name: "Uruguay" },
  venue: "AT&T Stadium, Arlington",
  kickoffISO: "2026-06-24T19:00:00.000Z", // 3pm ET, 3 days after match-38
}
```

A later kickoff is deliberate: it makes the hub show both states at once — one
match completed/locked, one still open with a live countdown.

### 1b. Add a `SERIES` registry

```ts
interface SeriesDef {
  ref: string;
  competition: string;
  display: { name: string; blurb: string; iconToken: string };
  eventRefs: string[];          // ordered; the host enumerates events from here
  aggregation: "sum";           // how per-event scores roll into the standing
  trophyLabel: string;          // series trophy minted to the top of the standing
}

const SERIES: Record<string, SeriesDef> = {
  "world-cup-2026": {
    ref: "world-cup-2026",
    competition: "FIFA World Cup 2026",
    display: {
      name: "World Cup 2026 — Spain's run",
      blurb: "Call every Spain match. Best across the group wins.",
      iconToken: "trophy",
    },
    eventRefs: ["match-38", "match-54"],
    aggregation: "sum",
    trophyLabel: "Group Oracle",
  },
};
```

Adding more matches later stays "append a `MATCHES` entry and its ref to
`eventRefs`" — no new code, no new deploy beyond the data. `eventRefs` is read live
(see knockout note), not frozen at series start.

### 1c. Series phase (derived, game-asserted)

```ts
type SeriesPhase = "upcoming" | "open" | "live" | "completed";
```

Derive it from the member events, but expose it as the game's signal so the game
stays the authority (it's the only thing that knows the bracket is exhausted):

- `upcoming` — no event open yet.
- `open` — at least one event is `open` (pickable).
- `live` — at least one event is `locked` and none still open / in play.
- `completed` — every event in `eventRefs` is `closed` **and** the game declares
  no further events coming.

For the 2-game pilot, completion is simply "both closed." The asserted form
matters once knockout rounds exist, because then `eventRefs` grows over time.

---

## Part 2 — The new API

Additive, parallel to the event endpoints, same JSON/CORS helpers. Nothing on the
existing routes changes.

```
GET  /series                      → [{ ref, display, eventCount, phase }]
GET  /series/{sref}               → SeriesView (the hub's data source)
GET  /series/{sref}/phase         → { phase: SeriesPhase, status }
```

Scoring is **pushed by the room, not pulled by the host** (decided pick model). The
room calls the host on close:

```
POST {roomsHost}/api/rooms/close
  { sref, ref, roomId, results: [{ playerId, points, placement, rewards }] }   (signed)
```

Same envelope as the existing single-event close — `roomId`, `results`, `rewards`
are unchanged, so the legacy no-`sref` path is untouched. The series adds three
things: top-level `sref` and `ref`, and a `points` field per row (the raw cascade
score the host sums for the aggregate). This extends `pushClose()`
(`lib/roomsClose.ts`), already fired from `/admin/resolve`.

And `/contract` gains one block so the host knows to ask:

```jsonc
"series": { "ref": "world-cup-2026", "aggregation": "sum" }
```

### `GET /series/{sref}` — the hub payload

This is the single call the host makes to render the hub. Everything in it is data
the game owns; the host overlays identity, picks, scores, and standing.

```jsonc
{
  "ref": "world-cup-2026",
  "display": { "name": "World Cup 2026 — Spain's run", "blurb": "...", "iconToken": "trophy" },
  "phase": "open",
  "events": [
    {
      "ref": "match-38",
      "label": "Spain vs Saudi Arabia",
      "stage": "Group H · Matchday 2",
      "expectedLockAt": "2026-06-21T16:00:00.000Z",
      "phase": "closed",
      "status": "scheduled",
      "result": { "score": "1-0", "outcome": "HOME" }   // present only when closed
    },
    {
      "ref": "match-54",
      "label": "Spain vs Uruguay",
      "stage": "Group H · Matchday 3",
      "expectedLockAt": "2026-06-24T19:00:00.000Z",
      "phase": "open",
      "status": "scheduled"
    }
  ],
  "standingSpec": { "aggregation": "sum", "trophyLabel": "Group Oracle" }
}
```

Per-event `phase` here is the same value `/phase/{ref}` returns — one source of
truth, not a parallel field. The host still polls `/phase/{ref}` to *trigger* lock
and scoring; the hub payload is for display.

### Scoring delivery — pushed boards, host-summed aggregate

`/score` stays as worldcup's **internal** pure scorer (still worth exposing as an
endpoint for the room's own testing and purity diffs), but the host no longer calls
it — under the chosen pick model the host has no picks to score. Instead:

- **Per event:** the room scores on close and pushes the ranked board via `/close`
  (shape above). The host stores it as the event scoreboard.
- **Aggregate:** the host sums the pushed per-event boards by `playerId` across the
  series' `eventRefs`. This stays host-side because only the host knows that the same
  identity played both rooms. No `/series/score` call is needed for a plain sum; add a
  room-pushed series total later only if a future series wants weighting.

The host is trusting the room's numbers (no recompute backstop), so the `/close`
signature is the integrity boundary — see the pick-model note in the runtime flow.

---

## Part 3 — What Rooms displays

Two surfaces: one card in the lobby, one hub behind it.

### Lobby card (one entry for the whole tournament)

Not two match cards — **one** "World Cup 2026" card. It shows:

- Series name + icon, blurb.
- Member count (host-owned).
- A progress + urgency line built from the hub payload: **"1 of 2 played · 1 open ·
  locks in 2d"**, where "locks in" is the soonest open event's `expectedLockAt`.
- A state pill from the series phase (open / live / completed).

This is the contract's existing lobby bucketing (open / live / recently closed)
scoped to a tournament — reuse it, don't invent a new shelf.

### Division of rendering

- **The hub is host-rendered.** It's navigation + identity + standing — all
  host-owned. The host builds it from `GET /series/{sref}` plus its own data
  (membership, the per-event scores it computed, the aggregate standing).
- **The per-event view is the game's bespoke renderer**, unchanged. Selecting an
  event loads `rendererUrl?ref=<event>` in the sandboxed iframe — and `page.tsx`
  already takes `?ref=`. Open → the pick builder; live → the watch view; closed →
  results + that event's board. Phase + readOnly are passed in as today.

So "select which event to connect to" happens in the host hub, and the only thing
selecting does is set the `?ref` the iframe loads. The renderer barely changes.

---

## Part 4 — The event hub

The screen behind the lobby card. Host chrome around the game's per-event renderer.

**Header.** Series title + blurb. The player's own aggregate line — **"Group
Oracle: 2nd of 18 · 1,004,003 pts"** — pulled from the host standing. Member count.

**Event list, grouped by what's actionable (not match order):**

- **Live now** — events that are `locked` and in play. (Empty in the pilot unless a
  match is underway.)
- **Open — locking soonest first** — Spain–Uruguay, with its lock countdown and the
  player's own state overlay: *needs pick / locked in / missed*. The nearest
  unpicked open event is the focal point (the F1 reminder hook, per event).
- **Completed** — Spain–Saudi, final score, the player's points for it, and a link
  into that event's board.

Each row carries: matchup + stage, lock/kickoff time, room phase, the host-derived
player-state overlay, and (when closed) the player's score and the result.

**Standing panel.** The aggregate leaderboard — top 10 plus the player's rank —
host-computed from audited per-event scores, **updated after every event**, not held
to the end. For two games it's the sum of `match-38` and `match-54` points. The
series trophy mints to the top when the series completes.

**Discoverability.** A single-match room on `match-38` shows a quiet "part of World
Cup 2026 →" link back to this hub. Costs nothing; it's how a one-match player finds
the tournament.

---

## Scoring, in one line per the earlier decision

The moment an event closes, the room scores its private picks and pushes the ranked
board to the host's `/close`; the host stores it and bumps each player's running
series total. The final World Cup scoreboard is just the last snapshot of that
running sum — nothing special computed at the end. Picks never leave the room.

---

## Runtime flow — the two-day sequence

The scenario, walked end to end. "Host" = Rooms; "room" = the worldcup service.

### Pick model (decided)

**Picks are never revealed to Rooms.** They live only in worldcup's `/pick` store,
forever. When an event finishes, worldcup scores it locally with its pure scorer and
**pushes the finished board** (per-player points + placement, no picks) to the host
via `/close`. The host stores that board, mints trophies, and sums the per-event
boards into the aggregate. Rooms shows the ranked leaderboard; it never knows what
anyone actually predicted — the pick-vs-actual breakdown is rendered by worldcup when
a player re-enters the closed event.

The trade, made consciously: **the host can't independently audit the board**, because
it has no picks to recompute from. Fine for a bragging-rights tournament. The signed
`/close` push is therefore doubly load-bearing — it's the *only* thing standing
between the host and a spoofed board, with no recompute backstop. A future staked game
that needs audit would use a reveal-at-close model instead (see Open decisions).

### Launch context

Entering the room launches `rendererUrl?sref=world-cup-2026&ref=<event>&t=<token>`.
`sref` tells the app which series; `ref` is the initial event (omit it and the app
opens its switcher on the soonest-locking open event). The token carries identity,
as today.

### T0 — both events open

- **Host hub shows two events by name**, both in the Open bucket:
  *Spain vs Saudi Arabia — open, locks in 3d* and *Spain vs Uruguay — open, locks in
  6d*. Player-state overlay on each: **needs pick**. Standing: empty.
- Player clicks Enter (or an event name → deep-links with that `ref`). In the room
  they see an **in-app event switcher** (Event 1 / Event 2) and the pick builder for
  the selected one. Pick event 1, switch, pick event 2, return.
- Per lock-in, worldcup stores the pick privately and fires the contentless
  `postMessage({ type: "rooms:locked", ref, playerId })`. The host learns *that* the
  player is locked in for that event — not what they picked — and flips the overlay
  to **locked in**. No picks cross.

### T+3d — event 1 locks at kickoff

- `/phase/match-38` → `locked` (clock hits kickoff). The host poll observes it,
  freezes any further pick writes for event 1, stamps `lockedAt`, and moves event 1
  from **Open** to **Live now**. Event 2 stays open and pickable.

### T+2d after that — event 1 finishes

Admin posts the result; `/phase/match-38` → `closed`. The close handshake for event 1,
**pushed by the room**:

1. On result entry, worldcup scores event 1 locally (its pure scorer over its private
   picks) and builds the board.
2. worldcup `POST {roomsHost}/api/rooms/close` with `{ sref, ref, roomId, results:
   [{ playerId, points, placement, rewards }] }`, **signed** with `ROOMS_SIGNING_KEY`.
   No picks in the payload.
3. The host verifies the signature, stores event 1's board, bumps each player's
   running series total, and mints event 1's per-room trophy.
4. The host's `/phase` poll independently observes `closed` and moves the event in the
   hub — a backstop so a dropped `/close` push can't strand the event silently.

**Now Rooms has "how players did" for event 1.** The hub moves Spain–Saudi to
**Completed** (final score + the player's points + a link to that event's board).
The Open bucket now holds **only Spain–Uruguay** — exactly your "only event 2
visible." Event 1 hasn't vanished; it's collapsed into Completed so you can still
see your result. The standing now reflects event 1.

### event 2 locks → finishes

Identical handshake on `match-54`: `locked` at kickoff → `closed` on result →
resolve + score → **event 2 board**. Rooms now has "how event 2 players did." The
hub shows both events Completed.

### Series completes — the overall result

When both events are `closed`, `/series/world-cup-2026/phase` → `completed`. The
host computes the **aggregate**: sum each player's event 1 + event 2 points by
`playerId` (only the host can — it owns the cross-event identity). Out comes the
overall standing across both games. The series trophy ("Group Oracle") mints to the
top. The hub's headline becomes the overall standing; per-event boards stay viewable
underneath.

So three distinct host-side mint moments, on three different days: event 1 board,
event 2 board, and the overall aggregate + series trophy at the end — never one
final reveal.

## What changes where

**worldcup (game):** add `match-54` to `MATCHES`; add the `SERIES` registry;
derive `seriesPhase`; add three routes (`/series`, `/series/[sref]`,
`/series/[sref]/phase`) and optionally `/series/score`; advertise `series` in
`/contract`. The per-event endpoints, the scorer, and the renderer are untouched.

**Rooms (host):** one lobby card per series; the host-rendered event hub; enumerate
events from `/series/{sref}` instead of a hardcoded ref; receive pushed per-event
boards at a signed `/close` endpoint; sum them into the aggregate standing; mint the
series trophy on completion. New `rooms_series` snapshot row (membership + observed
completion stamps) and the `/close` receiver, via the **additive** migration path —
never `db:migrate`.

**Unchanged:** the pick schema, validation, the pure cascade scorer, the bespoke
renderer, every per-event endpoint, the auth/session flow.

## Open decisions

- **Pick storage & audit — DECIDED: option B (room keeps picks private, pushes the
  board).** Rooms never sees a prediction; the room scores and pushes a signed board;
  the host sums boards into the aggregate and trusts them unaudited. Consequence to
  live with: no host-side recompute, so the `/close` signature is the sole integrity
  check. If a staked third-party game ever needs audit, it would use a reveal-at-close
  variant — but that's not worldcup, and not now.
- **Private series.** Per-match locked rooms get their own per-match trophies for
  free. Whether a locked room rolls into a *private* tournament standing (the office
  pool) is v2 — scope the pilot to public/canonical aggregation only.
- **Latecomers.** Someone joining at `match-54` can't catch a two-game player on a
  raw sum. Keep it a transparent sum for v1; normalization invites its own fight.
- **Tiebreaks.** The scalar makes ties intentional today. If the standing needs a
  defined tiebreak, the `ScoreBreakdown` carries a secondary key the host sorts on —
  game provides the key, host does the sort.
- **Series completion authority.** Pilot derives "both closed." Confirm the
  game-asserted `completed` signal before knockout rounds (dynamic `eventRefs`) land.

## Verification

`npm run build` (the canonical check) plus curling the new endpoints:
`/series`, `/series/world-cup-2026`, `/series/world-cup-2026/phase`. Confirm
`/series/score` purity by diffing two identical calls. Walk the hub with one event
forced `closed` (via `/admin/resolve` on `match-38`) and one `open` (`match-54`) to
see both buckets and a non-zero running standing.
