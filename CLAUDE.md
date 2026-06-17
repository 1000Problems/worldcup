# World Cup Match Predictor — a Rooms room

A third-party **room** (game) for the Rooms platform. Players predict the full
**scoreline plus the minute of every goal** of a single World Cup match before
kickoff, ranked by a magnitude-banded cascade. Seeded with **match-38: Spain vs
Saudi Arabia, Group H, 21 Jun 2026, Atlanta**.

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
| GET  | `/event/{ref}` | — | EventDef (pick schema + labels + lock time) |
| POST | `/validate` | `{ event, pick }` | `{ valid, reason? }` |
| GET  | `/phase/{ref}` | — | `{ phase, status }` |
| POST | `/resolve` | `{ ref }` | ResultDef \| null |
| POST | `/score` | `{ result, picks[] }` | ScoreBreakdown[] (PURE) |
| POST | `/rewards` | `{ result, standings }` | RewardProposal |
| POST | `/admin/resolve` | `{ ref, homeGoals, awayGoals, homeGoalMinutes[], awayGoalMinutes[] }` + Bearer token | ResultDef |

Pick shape: `{ homeGoals, awayGoals, homeGoalMinutes[], awayGoalMinutes[] }` (minute
arrays length = their goal count, each 1..120). `/score` is pure and ranks by a
cascade packed into one `points` scalar: `outcomeBand (1,000,000 if right
winner/draw) + scoreBand (0..9,999, exact tops it) + timingBand (0..99, closest
goal minutes)`. Magnitude-separated so a lower tier can't overflow a higher one;
identical-perfect predictions tie (shared win). Constants live in `lib/rooms.ts`.

## Auth model

- **Players**: "Login with Rooms" — the host launches the room at `/?t=<token>`,
  a JWT signed HS256 with `ROOMS_SIGNING_KEY`. We verify it **server-side** in
  `lib/roomsAuth.ts` (`page.tsx` is a server component; `RoomClient.tsx` is the
  client UI that receives only the safe claims). The token is stripped from the
  URL on load and never reaches client JS or logs. A missing/invalid token falls
  back to a clearly-labelled dev stub (`?name=`, untrusted). The UI hands picks to
  the host via `postMessage({ type: "rooms:pick", ref, pick, playerId })` and
  renders a required "Return to Rooms" link from the token's `returnUrl`.
- **Admin (result entry)**: `/admin/resolve` requires `Authorization: Bearer $ADMIN_TOKEN`.

## Environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `ROOMS_SIGNING_KEY` | for live identity | HS256 secret from the Rooms `/developer` page; verifies the `?t=` launch token **server-side only**. Set in Vercel env, never commit, never ship to the client. Without it, every player falls back to the dev stub. |
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

- **Cascade scoring — DONE.** `TASK-cascade-scoring.md` is implemented: structured
  scoreline + goal-minute pick, band-encoded pure scorer, bespoke builder UI.
  Verified by the worked example (exact+perfect-timing > exact > right-outcome >
  wrong-outcome) and a purity diff.
- **Host→ref routing (`ARCHITECTURE.md`).** `/contract` and the endpoints still
  default the ref; make them resolve the match from the subdomain before a second
  game URL goes live.
- **Identity from Rooms.** The renderer probe (debug panel in `page.tsx`) shows
  Rooms isn't yet handing the iframe a session (no query, no postMessage). Wire the
  real channel once Rooms exposes it; the probe already harvests query + postMessage.
- **GitHub CI.** PAT is expired; deploys currently go out via Vercel CLI from local
  source. Refresh the token and connect the repo for push-to-deploy.
