# World Cup Match Predictor — a Rooms room

A third-party **room** (game) for the Rooms platform. Players predict the outcome
of a single World Cup match — home win, draw, or away win — before kickoff. Seeded
with **match-38: Spain vs Saudi Arabia, Group H, 21 Jun 2026, Atlanta**.

The whole platform contract lives in `PROMPT-new-room-project.md`. Rooms owns
identity, the pick store, lock enforcement, and the audited scoreboard. This
service owns the game: the event, validation, phase signal, resolution, and a
**pure** scorer.

## Tech stack

- Next.js 14 (App Router, TypeScript), no database, no Tailwind.
- Route handlers live at the **root** paths Rooms expects (`/contract`, not `/api/contract`).
- Hosting: Vercel under the `1000Problems` org (see `references` in the deploy skill).
- Result storage: in-memory (see Critical notes). Rooms holds the durable picks.

## Project structure

```
src/
  app/
    page.tsx                 -- bespoke room UI (the iframe view); ?ref= selects the match
    layout.tsx, globals.css
    contract/route.ts        -- GET  /contract
    event/[ref]/route.ts     -- GET  /event/{ref}
    validate/route.ts        -- POST /validate
    phase/[ref]/route.ts     -- GET  /phase/{ref}
    resolve/route.ts         -- POST /resolve
    score/route.ts           -- POST /score   (PURE)
    rewards/route.ts         -- POST /rewards
    admin/resolve/route.ts   -- POST /admin/resolve  (manual result entry, token-gated)
  lib/
    rooms.ts                 -- match registry, options, pure scoring, result store
    http.ts                  -- JSON + CORS preflight helpers
```

## Adding more matches

One deployment serves the whole tournament. Add an entry to `MATCHES` in
`src/lib/rooms.ts` keyed by ref; each Rooms room points at a different `ref`.
No new code, no new deploy beyond shipping the data.

## API endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET  | `/contract` | — | Manifest |
| GET  | `/event/{ref}` | — | EventDef (options + labels + lock time) |
| POST | `/validate` | `{ event, pick }` | `{ valid, reason? }` |
| GET  | `/phase/{ref}` | — | `{ phase, status }` |
| POST | `/resolve` | `{ ref }` | ResultDef \| null |
| POST | `/score` | `{ result, picks[] }` | ScoreBreakdown[] (PURE) |
| POST | `/rewards` | `{ result, standings }` | RewardProposal |
| POST | `/admin/resolve` | `{ ref, homeGoals, awayGoals }` + Bearer token | ResultDef |

Pick ids: `ESP` (Spain win, +2), `DRAW` (+3), `KSA` (Saudi win, +5). Points reward
the bolder correct call. `/score` is pure: correct outcome → its point value, else 0.

## Auth model

- **Players**: "Login with Rooms" — the host signs them in and hands a signed
  session token (`playerId`, `displayName`, `avatarToken`). We do not build login.
  For early dev a stubbed player is fine; the UI hands picks to the host via
  `postMessage({ type: "rooms:pick", ref, pick })`.
- **Admin (result entry)**: `/admin/resolve` requires `Authorization: Bearer $ADMIN_TOKEN`.

## Environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `ADMIN_TOKEN` | for resolution | Bearer secret that gates `/admin/resolve`. Set in Vercel env, never commit. |

## State machine (per match ref)

```
open  ──(now ≥ kickoff)──▶  locked  ──(admin posts result)──▶  closed
```

`/phase` is the authority. `open` before kickoff, `locked` from kickoff until a
result is posted, `closed` once resolved. `/phase` may read the clock; `/score`
may not.

## Critical notes

- **`/score` must stay pure** — no IO, clock, or randomness. Rooms re-runs it to
  audit the board. All scoring constants live in `lib/rooms.ts`.
- **Result store is in-memory.** A serverless cold start clears the posted result;
  the admin re-posts via `/admin/resolve`. Fine because Rooms owns durable picks
  and only needs our pure scorer + the result. Swap for Neon/Vercel KV for
  production durability.
- **CORS + iframe**: contract endpoints send `Access-Control-Allow-Origin: *`
  (next.config.js + per-route OPTIONS). No `X-Frame-Options`, so the page embeds
  in the Rooms sandboxed iframe.
- **rendererUrl** in `/contract` is computed from the request origin, so it's
  correct on any deploy URL without hardcoding.

## Local dev

```bash
npm install
npm run dev          # http://localhost:3000
curl localhost:3000/contract
curl localhost:3000/event/match-38
```

## Build & verify

```bash
npm run build        # next build — the canonical check; must pass with zero type/lint errors
npm run lint         # next lint
npm start            # serve a production build; set ADMIN_TOKEN to exercise /admin/resolve
```

There is **no test framework** in this repo. Verification is `npm run build` plus
curling the endpoints (e.g. the worked example in `TASK-cascade-scoring.md`). When
changing the scorer, confirm purity by diffing two identical `/score` calls.

## Pending work

`TASK-cascade-scoring.md` specifies an unimplemented rebuild: replace the
outcome-only pick with a structured scoreline + goal-minute prediction, scored by
a magnitude-banded cascade (`outcomeBand + scoreBand + timingBand`) packed into
Rooms' single `points` scalar. The code today is still outcome-only (`ESP`/`DRAW`/
`KSA`); this doc describes the **current** state, not that task. If you implement it,
update this file's pick-ids and scoring sections.
