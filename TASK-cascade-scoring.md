# TASK: Cascade scoring — scoreline + goal-minute predictions

> Replace the outcome-only pick with a structured scoreline-and-goal-minutes prediction, scored by a three-tier cascade encoded into Rooms' single `points` scalar.

## Context

Outcome-only (Spain win / draw / Saudi win) collapses every player into three buckets — far too many co-winners. The design we settled on lets players predict the exact scoreline plus the minute of every goal, then ranks them by a strict cascade: right outcome first, then how close the scoreline is, then how close the goal minutes are. Rooms ranks players by one `points` number and exposes no separate tie-break field, so the cascade must be encoded as magnitude-separated bands inside that one number. Identical-perfect predictions (e.g. everyone who calls a 0-0) share the win — we do not break that tie.

The repo already has a working outcome-only room (Next.js App Router, the seven Rooms contract endpoints, a bespoke UI). This task rebuilds the data shapes, the scorer, the affected endpoints, and the UI. Read `CLAUDE.md` and `PROMPT-new-room-project.md` first — the platform contract and the canonical/ref-parameterized model are unchanged.

## Requirements

1. **Data shapes.** Introduce the structured `Pick` and expand `ResultDef` to carry goal minutes, with the exact TypeScript shapes in Implementation Notes. A pick is `{ homeGoals, awayGoals, homeGoalMinutes[], awayGoalMinutes[] }`; a result is the same plus `outcome` and `final`.

2. **Validation (pure).** `validatePick` accepts the structured pick and rejects: non-integer or negative goals, goals outside `0..20`, a `homeGoalMinutes`/`awayGoalMinutes` whose length ≠ its goal count, and any minute outside `1..120`. Returns `{ valid, reason? }` exactly as today.

3. **Pure cascade scorer.** Rewrite `scorePicks(result, picks)` to the band formula in Implementation Notes. `points = outcomeBand + scoreBand + timingBand`. Must stay pure — no clock, IO, or randomness — and identical inputs must always yield identical points (Rooms re-audits the board). Include a `detail` object that explains each band for display.

4. **Endpoint + result-store updates.** Update `/event/{ref}` (advertise the pick fields), `/validate`, `/resolve`, `/score`, `/rewards`, `/admin/resolve`, and `setResult`/`getResult` in `lib/rooms.ts` to the new shapes. `/admin/resolve` now also accepts and validates `homeGoalMinutes`/`awayGoalMinutes`. `/rewards` proposes the trophy to every player tied at the top score (shared win) and a `called-it` badge to every correct-outcome player.

5. **Bespoke UI rebuild.** Rebuild `src/app/page.tsx`: goal steppers for each team, and when a team's goal count is set, render that many minute inputs for it. Show a live preview line (e.g. `Spain 2 (10', 20') — 0 Saudi Arabia`). Hand the full structured pick to the host via `postMessage({ type: "rooms:pick", ref, pick })`. Disable all inputs when `/phase` is not `open`.

## Implementation Notes

**Files in scope** (modify): `src/lib/rooms.ts`, `src/app/page.tsx`, `src/app/event/[ref]/route.ts`, `src/app/validate/route.ts`, `src/app/resolve/route.ts`, `src/app/score/route.ts`, `src/app/rewards/route.ts`, `src/app/admin/resolve/route.ts`, `src/app/contract/route.ts` (pickSchema only), `src/app/globals.css` (new UI styles), `CLAUDE.md` (update pick ids / scoring section).

**Types** (in `src/lib/rooms.ts`):

```ts
export type OutcomeId = "ESP" | "DRAW" | "KSA";

export interface Pick {
  homeGoals: number;          // 0..20
  awayGoals: number;          // 0..20
  homeGoalMinutes: number[];  // length === homeGoals, each 1..120
  awayGoalMinutes: number[];  // length === awayGoals, each 1..120
}

export interface ResultDef {
  ref: string;
  homeGoals: number;
  awayGoals: number;
  outcome: OutcomeId;         // derived from the score
  homeGoalMinutes: number[];
  awayGoalMinutes: number[];
  final: true;
}

export interface PlayerPick { playerId: string; pick: Pick; }

export interface ScoreBreakdown {
  playerId: string;
  points: number;
  detail: {
    outcome: { picked: OutcomeId; actual: OutcomeId; correct: boolean };
    score: { picked: string; actual: string; exact: boolean; gdMatch: boolean; totalMatch: boolean };
    timing: { comparable: boolean; error: number };
    bands: { outcome: number; score: number; timing: number };
  };
}
```

**Outcome helper:** `outcomeOf(h, a) = h > a ? "ESP" : h < a ? "KSA" : "DRAW"`.

**Band formula** (constants are tunable but must preserve the band magnitudes so a lower tier can never overflow into a higher one):

```
W_OUTCOME = 1_000_000

outcomeBand = outcomeOf(p.homeGoals, p.awayGoals) === result.outcome ? W_OUTCOME : 0

// Tier 2 — score accuracy, capped to [0, 9_999]
homeErr = |p.homeGoals - result.homeGoals|
awayErr = |p.awayGoals - result.awayGoals|
exact    = homeErr === 0 && awayErr === 0
gdMatch  = (p.homeGoals - p.awayGoals) === (result.homeGoals - result.awayGoals)
totMatch = (p.homeGoals + p.awayGoals) === (result.homeGoals + result.awayGoals)
scoreBand = min(9999,
    (exact   ? 4000 : 0)
  + (gdMatch ? 2000 : 0)
  + (totMatch? 1000 : 0)
  + max(0, 2000 - 250 * (homeErr + awayErr)))
// exact tops out at 9000; gdMatch and totMatch together imply exact, so no double-count concern

// Tier 3 — goal-minute closeness, capped to [0, 99]
predMin = sort([...p.homeGoalMinutes, ...p.awayGoalMinutes])
actMin  = sort([...result.homeGoalMinutes, ...result.awayGoalMinutes])
comparable = predMin.length === actMin.length        // only when total goal count matches reality
timingError = comparable ? sum(|predMin[i] - actMin[i]|) : Infinity
timingBand  = comparable ? max(0, 99 - timingError) : 0
// a 0-0 prediction vs a 0-0 result: both lists empty, error 0, band 99

points = outcomeBand + scoreBand + timingBand
```

Timing deliberately ignores which team scored — it compares the merged, sorted minute lists. A wrong-outcome player still gets a real `points` value (their score/timing bands) but always ranks below every correct-outcome player because they lack `W_OUTCOME`. Shared wins fall out for free: equal `points` ⇒ equal rank; no special-casing.

**Result store:** `setResult(ref, homeGoals, awayGoals, homeGoalMinutes, awayGoalMinutes)` derives `outcome` and stores the full `ResultDef`. Keep it in-memory exactly as now (Rooms owns durable picks).

**`/admin/resolve` validation:** reject if either minutes array length ≠ its goal count, or any minute is not an integer in `1..120`. Keep the `Bearer $ADMIN_TOKEN` gate unchanged.

**`/contract` pickSchema:** change to advisory composite, since this is no longer a tier-1 primitive and the renderer is bespoke:
```jsonc
"pickSchema": { "kind": "scoreline-timed",
  "fields": ["homeGoals", "awayGoals", "homeGoalMinutes", "awayGoalMinutes"] }
```
Leave `capabilities.renderer: "bespoke"` and the canonical/ref model as-is.

**UI flow (`page.tsx`):** keep the existing fetch of `/event/{ref}` and `/phase/{ref}` and the locked-state handling. Replace the three outcome buttons with: a `−`/`+` stepper per team for goals, then conditionally rendered minute inputs (one per goal). Build the `Pick` object on every change, show the preview line, and `postMessage` it. No new dependencies — plain React state and the existing CSS approach.

## Do Not Change

- `src/lib/http.ts` — CORS/preflight helper is correct as-is.
- `next.config.js` — CORS headers and the no-`X-Frame-Options` iframe rule are load-bearing; leave them.
- `src/app/layout.tsx` — root layout is fine.
- `src/app/phase/[ref]/route.ts` and `phaseFor()` — the lock-at-kickoff clock logic is unchanged by this task.
- The **purity of `/score`** — no clock, IO, or randomness may enter the scorer. This is the platform's audit guarantee.
- The **canonical, ref-parameterized model** — one deployment serves all matches; do not hardcode match-38 anywhere outside the `MATCHES` registry.
- `package.json` dependencies — no new packages; this is plain Next.js + React.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type or lint errors.
- [ ] `/validate` rejects a `{homeGoals:2, awayGoals:0, homeGoalMinutes:[10]}` pick (minute count ≠ goal count) and accepts `{homeGoals:2, awayGoals:0, homeGoalMinutes:[10,20], awayGoalMinutes:[]}`.
- [ ] With actual result **Spain 2–0, goals 10' and 20'**: a player picking 2–0 with minutes `[10,20]` scores higher than one picking 2–0 with `[5,40]`, who scores higher than one picking 2–1 (right outcome, wrong score), who scores higher than any Saudi-win or draw picker. Verify the exact ordering with a quick script against `/score`.
- [ ] `/score` is pure: calling it twice with identical `{result, picks}` returns byte-identical output.
- [ ] A 0–0 actual result gives every 0–0 picker an equal top `points` (shared win), and `/rewards` proposes the trophy to all of them.
- [ ] `/admin/resolve` with a valid Bearer token and `{homeGoals, awayGoals, homeGoalMinutes, awayGoalMinutes}` stores the result and flips `/phase` to `closed`.
- [ ] The room page lets you set a scoreline, reveals the right number of minute inputs, shows the preview line, and posts the structured pick (check the browser console / a stub parent listener).
- [ ] `git diff` shows changes only in the files listed under Implementation Notes.

## Verification

1. Run `npm run build`; fix any type errors (the scorer's `detail` shape must match `ScoreBreakdown`).
2. Start `next start` with `ADMIN_TOKEN=test`, then curl the worked example in Acceptance Criteria and confirm the ordering numerically.
3. Confirm `/score` purity by diffing two identical calls.
4. Check `git diff --stat` — nothing outside the scoped file list.
5. Load `/` in a browser, build a 2–1 prediction, and confirm three minute inputs appear (2 for Spain, 1 for Saudi) and the posted pick object is well-formed.
