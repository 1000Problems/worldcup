# TASK: Port the "Goal Rush" redesign into RoomClient (predict + result)

> Replace the current functional RoomClient UI with the Goal Rush redesign —
> rebrand, 3-step wizard, goal-minute timeline, and a result/leaderboard view —
> while preserving the Rooms integration. Chat is a separate task; do not build it here.

## Context

The current `src/app/RoomClient.tsx` is a single-column functional form with a
free-text minute input and a debug probe. A high-fidelity prototype
("Goal Rush.dc.html", in the design handoff) reimagines it: a branded two-column
layout with a guided wizard, a tap-to-place goal-minute timeline, and a
full-time leaderboard. The prototype is written in a bespoke `.dc` component
runtime, **not** React, so this is a port, not a copy. This task covers the
**predict column and the result view only** — the chat ("Banter Box") column is
specced separately in `TASK-chat-backend.md` and `TASK-banter-box-ui.md`. Leave
a sized empty slot where the chat column will mount.

## Requirements

1. **Rebrand + layout.** Apply the Goal Rush identity (Oswald + Archivo fonts,
   `#E20613` red system, the header logo/tagline) and a responsive two-column
   grid (predict ~470px + flexible chat slot) that collapses to mobile tabs
   below 900px, matching the prototype. Move styles into `globals.css`; keep
   components in `RoomClient.tsx`.
2. **Three-step wizard** (open phase, not yet submitted): Step 1 winner cards
   (Spain / Draw / Saudi), Step 2 exact-score steppers with a live outcome pill,
   Step 3 the goal-minute timeline. Back/Next nav, a "Your call" ticket summary,
   and a final "Lock it in" that fires the existing pick submission.
3. **Goal-minute timeline.** Tap a 0→full-time track to place each goal's minute;
   tap a placed marker to clear it; goal "chips" select which goal you're timing.
   The track MUST span **1..120** (extra time), not 90 — placing markers and tick
   labels accordingly. This replaces the free-text minute inputs.
4. **Phase states.** Render the four states the prototype defines, driven by the
   real phase: `open` → wizard (or locked-in "ticket" once submitted) ; `locked`
   → "entries closed / kick-off" ; `closed`(=resolved) → the result view. Source
   the phase from `/phase/{ref}` as today — do NOT add a clickable phase switcher
   to production UI (any dev switcher belongs behind the dev gate in
   `TASK-dev-state-controls.md`).
5. **Result view from the server scorer.** The leaderboard, winner banner, your-
   rank note, and the `✓ result / 🎯 exact / ⏱ timing` chips MUST be built from
   the `/score` response (and `/resolve` for the result), NOT from a
   reimplemented scorer in the client. Delete the prototype's local `scorePick`
   entirely. Confetti on lock-in may stay (pure presentation).

## Implementation Notes

- **Files to modify:** `src/app/RoomClient.tsx`, `src/app/globals.css`. You may
  add presentational sub-components under `src/app/` if it keeps RoomClient
  readable. Do not add new dependencies — fonts load via the existing `<link>`
  pattern; everything else is inline React.
- **Team labels are data, not literals.** The prototype hardcodes "Spain"/"Saudi
  Arabia". Drive all team names, codes, and tints from the `event` payload
  (`event.labels.home/away`) keyed by `matchRef`, so the one-deployment-many-
  matches model in `CLAUDE.md` still holds.
- **Goal cap:** respect the server's `MAX_GOALS` (currently 20), not the
  prototype's 9.
- **Pick handoff unchanged.** Keep the existing `postMessage({ type: "rooms:pick",
  ref, pick, playerId })` flow and pick shape `{ homeGoals, awayGoals,
  homeGoalMinutes[], awayGoalMinutes[] }`. The wizard is a new way to *collect*
  the same pick — the submit path and validation call must not change.
- **Result data shapes:** fetch the final result from `POST /resolve { ref }`
  and the ranked board from `POST /score { result, picks[] }`. Render ranks,
  outcome/exact/timing flags, and the tiebreak explainer from those responses.
  If the picks needed for the board aren't available to the client, leave a
  clearly-marked TODO and render only "your result" from `/score` on your own
  pick — do not fabricate other players' rows.
- **Identity + return link:** keep reading `player` / `returnUrl` / `devName` /
  `tokenHint` props from `page.tsx`; keep the dev-stub label and the required
  "Return to Rooms" link.
- **Debug probe:** keep the Rooms-connection debug section. It may be collapsed
  by default, but it must remain — it is the only window into the unresolved
  iframe-session issue (`CLAUDE.md` pending work). Do not delete it.

## Do Not Change

- `src/lib/rooms.ts` — the pure scorer + match registry are the audited source
  of truth; the UI displays its output, never reimplements it.
- `src/lib/roomsAuth.ts`, `src/app/page.tsx` (token verification flow) — identity
  is server-verified; don't move verification into the client.
- Any route handler under `src/app/{contract,event,validate,phase,resolve,score,
  rewards,admin}` — this task is UI only.
- The `postMessage` pick contract and pick/validate shapes.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] All four phase states render and are reachable from real phase data; no
      production phase-switcher buttons exist.
- [ ] Timeline accepts and displays minutes up to 120; clearing/re-placing works.
- [ ] Team names/colors render from `event` data — temporarily changing the ref's
      labels in `rooms.ts` changes the UI with no other code edits.
- [ ] No `scorePick`/scoring math exists in client code (`grep` is clean); the
      result view's numbers come from `/score` / `/resolve`.
- [ ] Debug probe and "Return to Rooms" link still present.
- [ ] `git diff` shows changes only in `RoomClient.tsx`, `globals.css`, and any
      new presentational components under `src/app/`.

## Verification

1. `npm run build`, then `npm start` and curl `/event/match-38`, `/phase/match-38`.
2. Walk the wizard end-to-end with `?name=Dev`; confirm the submitted pick
   matches the `postMessage` payload shape unchanged.
3. `grep -rn "scorePick\|outcomeOf\|1000000\|9999" src/app` returns nothing.
4. `git diff --stat` — only the files listed above.
