# TASK: Own event navigation; emit event-close + series-close for all players

> Rooms now launches straight into worldcup and renders no event chooser of its
> own. worldcup must (1) show its own launch landing that lets a player pick which
> match to play, and (2) push two signed messages to Rooms — an **event-close**
> per match and one **series-close** for the whole series — each carrying the full
> board for every player, so the host can mint the three trophies.

## Context

The Rooms host has been thinned (see the Rooms repo's
`TASK-rooms-series-launch-and-trophies.md`). It no longer hosts a series hub or an
event picker — clicking the door launches worldcup full-page. So worldcup owns all
navigation between its matches.

Trophies are host-minted but worldcup is the authority on who won: one trophy per
match and one for the series. The host does NOT recompute the series standing —
winning both matches does not win the series; the aggregation rule is ours. We
push a pre-ranked standing and the host mints to whoever we place first.

Today `lib/roomsClose.ts` `pushClose()` already sends a per-event board
(`{ sref, ref, roomId, results }`). This task adds the explicit `type`
discriminator, guarantees the board covers every player, and adds the missing
**series-close** push.

## Requirements

1. **Launch landing.** In `src/app/page.tsx`, when launched with **no** `ref`
   (the host's launch URL carries only the token), render a chooser listing the
   matches of the series the player belongs to (`SERIES["world-cup-2026"].eventRefs`
   via `listSeries`/`getSeries` in `src/lib/rooms.ts`) — each with its label,
   stage, phase, and lock countdown — linking to `?ref=<eventRef>`. A `ref` in the
   URL still deep-links straight into that match (current behavior). Default-to
   `match-38` only as a dev fallback when no series context exists.

2. **`event-close` push, all players.** In `lib/roomsClose.ts`, add
   `type: "event-close"` to the pushed body and confirm `toResults()` includes
   **every** player with a verified pick for that event (full board, not just the
   winner). Keep `points` + `placement` per row; keep the per-row `rewards`
   (advisory). Add a top-level `trophyLabel` (the per-event trophy label, e.g.
   `"Oracle of Atlanta"`).

3. **`series-close` push, all players.** Add `pushSeriesClose(sref)` that fires
   once the final event of the series is closed (`seriesPhase(sref) === "completed"`).
   It computes worldcup's own series standing across `eventRefs` — sum each
   player's per-event `points` (the pilot rule; this is OUR rule, kept here so it
   can change without touching Rooms) — ranks it with standard competition
   ranking, and POSTs a signed body:

   ```jsonc
   { "roomId": "<roomId>", "sref": "world-cup-2026", "type": "series-close",
     "eventRefs": ["match-38","match-54"], "trophyLabel": "Group Oracle",
     "standing": [ { "playerId": "p_…", "points": 2014, "placement": 1 }, … ] }
   ```

   Sign the exact raw bytes with `ROOMS_SIGNING_KEY` (HMAC-SHA256, same as
   `pushClose`). POST to `${roomsHost}/api/rooms/close`.

4. **Wire the triggers.** In `src/app/admin/resolve/route.ts`, after the existing
   `pushClose(result)` (the event-close), call `pushSeriesClose(sref)` when
   resolving the event makes the series complete. Both pushes are best-effort and
   idempotent on the host (a re-resolve may re-push; the host dedups).

## Implementation Notes

- Series standing is worldcup's: build it from `listPicks(ref)` + `scorePicks`
  per `eventRef`, summing `points` by `playerId`. Reuse the standard-competition
  ranking already in `toResults()` (ties share a rank, next rank skips). A player
  who missed an event contributes 0 for it but still appears if they played any
  event.
- The launch context (`roomId`, `roomsHost`) comes from `launchCtx(ref)` /
  `launchCtx` of any member event — the same harvested context `pushClose` uses.
  If no context or no `ROOMS_SIGNING_KEY`, skip with a reason (mirror `pushClose`).
- Keep the pick model intact: **picks never leave worldcup.** Only
  points/placement/playerId go to Rooms.
- `/contract` already advertises `series: { ref:"world-cup-2026", aggregation:"sum" }`
  — leave it; it's what makes Rooms render the gate as a series.

## Do Not Change

- `src/app/score/route.ts` and `scorePicks` in `src/lib/rooms.ts` — the scorer is
  PURE and audited by Rooms; do not add IO/clock/randomness.
- The `/pick` store and the picks-stay-here invariant — never send a pick to Rooms.
- The launch-token verification (`lib/roomsAuth.ts`, `middleware.ts`,
  `lib/roomSession.ts`) and the HS256/ES256 auth path.
- `SERIES`/`MATCHES` shapes beyond what requirement 1 reads — no schema churn.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] Launched with no `ref`, the page shows both matches and lets the player pick;
      `?ref=match-38` still deep-links into that match.
- [ ] Resolving a match POSTs a signed `event-close` whose `results` cover every
      player with a verified pick for that event.
- [ ] Resolving the final match additionally POSTs a signed `series-close` whose
      `standing` covers every player who played any event, ranked by worldcup's sum.
- [ ] A purity diff on `/score` is unchanged (two identical calls match).
- [ ] `git diff` touches only the files named above.

## Verification

1. `npm run build`.
2. With `ROOMS_SIGNING_KEY` and `ADMIN_TOKEN` set, seed two picks across
   `match-38` and `match-54`, resolve both via `/admin/resolve`, and capture the
   outbound bodies (log them in dev): confirm two `event-close` posts and one
   `series-close`, each signed, each covering all players.
3. Confirm the HMAC over the exact body matches what Rooms expects (diff against
   the worked example in `TASK-cascade-scoring.md` style).
4. `git diff` — no files outside scope.
