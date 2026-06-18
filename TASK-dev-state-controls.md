# TASK: Dev state controls — drive the room through its lifecycle on demand

> Add a token-gated `/dev` page with Lock / Resolve / Reset buttons so the Rooms side can be developed against a room that moves through `open → locked → closed → open` without waiting for the real kickoff.

## Context

Today `/phase` is computed from the clock (locks at the 21 Jun 2026 kickoff) and the result store, so there's no way to exercise the state transitions before kickoff. The Rooms team needs to watch a connected room change state — lock the picks, resolve to a winner, then wipe and start over — to build and test the host side (state display, winner payload). This task adds a manual override and a small operator page to drive it. It must be safe to leave on the production deployment, since real users are in the lobby — so every state-mutating action is gated by the existing `ADMIN_TOKEN`.

Important boundary: Reset only wipes **our** state (posted result + manual lock). Rooms owns the pick store, so the players' picks are cleared on the Rooms side, not here — the `/dev` page must say so.

## Requirements

1. **Manual lifecycle override** in `src/lib/rooms.ts`: an in-memory per-ref "locked" flag plus a `reset` that clears both the flag and the posted result. `phaseFor` becomes: `closed` if a result is posted → else `locked` if manually locked **or** `now ≥ kickoff` → else `open`. `/score` stays pure and untouched.

2. **Two token-gated endpoints** mirroring the existing `/admin/resolve` Bearer gate: `POST /admin/lock { ref }` (sets the manual lock) and `POST /admin/reset { ref }` (clears result + lock). Both return the resulting `{ ref, phase }`. Missing/wrong token → 401; unknown ref → 404.

3. **`/dev` operator page** (`src/app/dev/page.tsx`, client): a password field for the admin token (held in `sessionStorage`, never hard-coded), a live phase readout polling `/phase/{ref}`, and three buttons — **Lock**, **Resolve**, **Reset** — each calling its endpoint with `Authorization: Bearer <token>`. Show the last action's outcome, the current phase, and the current `/resolve` payload. Default `ref` = `match-38` (overridable via `?ref=`). Surface a clear "bad token" message on 401.

4. **Resolve is the canned scenario:** the Resolve button posts the hardcoded result **Spain 1–0, goal at minute 10** to `/admin/resolve` — body `{ ref, homeGoals: 1, awayGoals: 0, homeGoalMinutes: [10], awayGoalMinutes: [] }` — so Rooms always tests the same known winner. The page must display the "Reset clears our result + lock only; Rooms owns the picks" caveat.

## Implementation Notes

**Files** — modify: `src/lib/rooms.ts` (lock set + reset + `phaseFor`). Create: `src/app/admin/lock/route.ts`, `src/app/admin/reset/route.ts`, `src/app/dev/page.tsx`. Optionally add styles to `globals.css`. Update `CLAUDE.md` state-machine + endpoint table.

**rooms.ts additions:**

```ts
const manualLocks = new Set<string>();
export function setLock(ref: string) { manualLocks.add(ref); }
export function clearLock(ref: string) { manualLocks.delete(ref); }
export function reset(ref: string) { results.delete(ref); manualLocks.delete(ref); }

export function phaseFor(m: MatchDef, now: Date = new Date()): Phase {
  if (getResult(m.ref)) return "closed";
  if (manualLocks.has(m.ref) || now.getTime() >= new Date(m.kickoffISO).getTime()) return "locked";
  return "open";
}
```

(`results` is the existing `Map`; expose a deletion path via `reset`. Keep everything in-memory — same durability note as the result store; a cold start clears overrides, which is fine for a dev tool.)

**Endpoint shape** — copy the auth guard from `src/app/admin/resolve/route.ts` (the `process.env.ADMIN_TOKEN` + `Authorization: Bearer` check, 500 if unset, 401 if mismatch), then call `setLock`/`reset` and return `{ ref, phase: phaseFor(getMatch(ref)!) }`. Add `OPTIONS` preflight via the shared `preflight()` helper like the other routes.

**`/dev` page** — plain client component, no new deps. Keep the token only in React state + `sessionStorage`; never embed it. Poll `/phase/{ref}` every ~3s and re-poll after each action. Each button: `fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: \`Bearer ${token}\` }, body: JSON.stringify(...) })`. The Resolve body is the canned Spain 1–0 @10'. This page is reachable by anyone, but does nothing without the correct token — the real protection is the endpoint gate.

## Do Not Change

- `scorePicks` / the cascade scorer and its constants — `/score` stays pure; this task only touches phase/result state, never scoring.
- Identity verification: `src/app/page.tsx` (server component), `src/lib/roomsAuth.ts`, `RoomClient.tsx` — untouched.
- The existing `/admin/resolve` validation and Bearer gate — reuse it, don't weaken it.
- `/contract`, `/event`, `/validate`, `/score`, `/rewards`, `/phase` response shapes — only `phaseFor`'s internal logic changes.
- The canonical, ref-parameterized model and CORS/iframe headers.
- No new npm dependencies.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] Before kickoff with no result: `/phase/match-38` is `open`.
- [ ] `POST /admin/lock` (valid token) → `/phase/match-38` becomes `locked`; without a token → 401 and phase unchanged.
- [ ] Resolve (Spain 1–0 @10') → `/phase` is `closed`, `/resolve` returns `{ outcome: "HOME", homeGoals: 1, awayGoals: 0, homeGoalMinutes: [10], … }`, and `/score` credits a 1–0/10' pick as the top scorer.
- [ ] `POST /admin/reset` (valid token) → `/phase` back to `open` and `/resolve` returns `null`.
- [ ] The `/dev` page drives all three transitions with a pasted token, shows the live phase updating, and rejects a wrong token with a visible message.
- [ ] `git diff` shows changes only in the files listed under Implementation Notes.

## Verification

1. `npm run build`, then `next start` with `ADMIN_TOKEN=test`.
2. `curl` the sequence: `/phase` (open) → `/admin/lock` → `/phase` (locked) → `/admin/resolve` canned body → `/phase` (closed) + `/resolve` → `/admin/reset` → `/phase` (open).
3. Confirm each admin endpoint returns 401 without the Bearer token.
4. Load `/dev`, paste the token, and walk Lock → Resolve → Reset, watching the phase readout follow.
5. From the Rooms `/developer` side, open the room and confirm the state change is visible after each button.
