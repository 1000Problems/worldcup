# TASK: World Cup as a series of events (game side)

> Turn the worldcup room from one match into a series of matches: add Spain–Uruguay, expose a series the host can enumerate, and tag the close-push with the series ref.

## Context

worldcup currently answers for a single fixture (`match-38`, Spain–Saudi). We want the host (Rooms) to present all of a tournament's matches under one game and keep a running standing across them. The data layer already supports many matches — `MATCHES` and the store are per-ref — so this task adds the *series* layer the host reads, plus a second match. Full design and rationale: `DESIGN-series.md` (the spec of record for shapes; read it first). The pick model is **decided**: picks never leave worldcup; the room scores on close and pushes a board, host sums boards into the aggregate.

## Requirements

1. Add a second match `match-54` (Spain vs Uruguay) to `MATCHES` in `src/lib/rooms.ts`, alongside the existing `match-38`.
2. Add a `SERIES` registry and `SeriesDef` type in `src/lib/rooms.ts`: one series `world-cup-2026` whose `eventRefs` are `["match-38", "match-54"]`, `aggregation: "sum"`, with display + a `trophyLabel`.
3. Add a pure-ish `seriesPhase(sref)` deriving `"upcoming" | "open" | "live" | "completed"` from the member events' phases (it may read the clock, exactly like `phaseFor`; it must not score).
4. Add three route handlers at the **root** (not under `/api`), mirroring the existing event routes' style (`force-dynamic`, `json`/`preflight` from `@/lib/http`, an `OPTIONS` export): `GET /series`, `GET /series/[sref]`, `GET /series/[sref]/phase`. Add a `series` block to the `/contract` manifest.
5. Extend the close-push so the board is attributed to its series: add `sref` to the payload `pushClose()` sends to `{roomsHost}/api/rooms/close` (`src/lib/roomsClose.ts`, fired from `src/app/admin/resolve/route.ts`). The board still carries placement + points only — **never picks**.

## Implementation Notes

- **Files to create:** `src/app/series/route.ts`, `src/app/series/[sref]/route.ts`, `src/app/series/[sref]/phase/route.ts`.
- **Files to modify:** `src/lib/rooms.ts` (MATCHES + SERIES + seriesPhase), `src/app/contract/route.ts` (series block), `src/lib/roomsClose.ts` (add `sref`), and `src/app/admin/resolve/route.ts` only if the `sref` lookup is wired there.
- **`match-54` data:**
  ```ts
  "match-54": {
    ref: "match-54",
    competition: "FIFA World Cup 2026",
    stage: "Group H · Matchday 3",
    home: { code: "ESP", name: "Spain" },
    away: { code: "URU", name: "Uruguay" },
    venue: "AT&T Stadium, Arlington",
    kickoffISO: "2026-06-24T19:00:00.000Z",
  }
  ```
- **`SeriesDef` shape:**
  ```ts
  interface SeriesDef {
    ref: string; competition: string;
    display: { name: string; blurb: string; iconToken: string };
    eventRefs: string[]; aggregation: "sum"; trophyLabel: string;
  }
  ```
- **`GET /series/[sref]` response** (the hub's data source) — labels come from `getMatch`, `phase` from `phaseFor`, the same value `/phase/{ref}` returns:
  ```jsonc
  {
    "ref": "world-cup-2026",
    "display": { "name": "...", "blurb": "...", "iconToken": "trophy" },
    "phase": "open",
    "events": [
      { "ref": "match-38", "label": "Spain vs Saudi Arabia", "stage": "Group H · Matchday 2",
        "expectedLockAt": "2026-06-21T16:00:00.000Z", "phase": "closed", "status": "scheduled",
        "result": { "score": "1-0", "outcome": "HOME" } },
      { "ref": "match-54", "label": "Spain vs Uruguay", "stage": "Group H · Matchday 3",
        "expectedLockAt": "2026-06-24T19:00:00.000Z", "phase": "open", "status": "scheduled" }
    ],
    "standingSpec": { "aggregation": "sum", "trophyLabel": "Group Oracle" }
  }
  ```
  `result` is present only when that event's phase is `closed`. `GET /series` returns `[{ ref, display, eventCount, phase }]`. `GET /series/[sref]/phase` returns `{ phase, status }` from `seriesPhase`.
- **`/contract` series block:** add `"series": { "ref": "world-cup-2026", "aggregation": "sum" }`.
- **Helper to find a ref's series:** a small `seriesForEvent(ref)` over `SERIES` so `roomsClose` can attach `sref` (omit / null if the event is in no series — a standalone match still works).

## Do Not Change

- `scorePicks()` and the scoring constants (`W_OUTCOME`, `SCORE_CAP`, `TIMING_CAP`) in `src/lib/rooms.ts` — `/score` must stay **pure** (no IO, clock, or randomness); Rooms re-runs it. Series work does not touch the scorer.
- `src/app/score/route.ts`, `src/app/event/[ref]/route.ts`, `src/app/phase/[ref]/route.ts`, `src/app/validate/route.ts`, `src/app/resolve/route.ts` — per-event behavior is unchanged.
- The pick-privacy model: picks live only in `src/lib/store.ts` / `src/app/pick/route.ts` and must **never** appear in any `/series*` response or the `/close` payload.
- Auth/session: `roomsAuth.ts`, `roomSession.ts`, `chatSession.ts`, `launchVerifyAsym.ts`.
- `next.config.js` CORS / iframe headers — do not add `X-Frame-Options`; `rendererUrl` stays computed from the request origin.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] `curl localhost:3000/series` and `/series/world-cup-2026` and `/series/world-cup-2026/phase` return the shapes above.
- [ ] `curl localhost:3000/contract` includes the `series` block.
- [ ] `curl localhost:3000/event/match-54` returns the Spain–Uruguay event.
- [ ] After `POST /admin/resolve { ref: "match-38", ... }`, the body's `pushClose` payload includes `sref: "world-cup-2026"` and no picks.
- [ ] Two identical `POST /score` calls return byte-identical output (purity unchanged).
- [ ] `git diff` shows changes only in the files listed under Implementation Notes.

## Verification

1. `npm run build`, then `npm start` with `ADMIN_TOKEN` set.
2. Curl every endpoint in the acceptance list.
3. Resolve `match-38` and inspect the returned `roomsClose` for `sref` and absence of picks.
4. Diff two `/score` calls to confirm purity.
