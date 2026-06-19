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
| POST | `/admin/lock` | `{ ref }` + Bearer token | `{ ref, phase }` (dev: force `locked`) |
| POST | `/admin/reset` | `{ ref }` + Bearer token | `{ ref, phase }` (dev: wipe result + lock → `open`) |

The `/dev` page is a token-gated operator console for these: Lock → Resolve (canned
Spain 1–0 @10′) → Reset, with a live `/phase` readout. Drives the lifecycle without
waiting for the real kickoff. Reset clears only our state; Rooms owns the picks.

Pick shape: `{ homeGoals, awayGoals, homeGoalMinutes[], awayGoalMinutes[] }` (minute
arrays length = their goal count, each 1..120). `/score` is pure and ranks by a
cascade packed into one `points` scalar: `outcomeBand (1,000,000 if right
winner/draw) + scoreBand (0..9,999, exact tops it) + timingBand (0..99, closest
goal minutes)`. Magnitude-separated so a lower tier can't overflow a higher one;
identical-perfect predictions tie (shared win). Constants live in `lib/rooms.ts`.

## Auth model

> **Launch signing is HS256 today — this is the INTERIM v1 path.** The agreed
> target (`ROOMS-reply-confirm-jwks.md`) is a stateless **ES256-over-JWKS** cutover:
> pin the alg, check `iss`, check `aud`, key by `kid` with one refetch on an unknown
> kid. None of that is built yet — it's gated on Rooms publishing the production
> `iss` / JWKS URL. The symmetric per-room key below is correct for the match-38
> pilot; treat it as interim so the cutover doesn't get lost.

- **Players**: "Login with Rooms" — the host launches the room at `/?t=<token>`,
  a JWT signed HS256 with `ROOMS_SIGNING_KEY`. We verify it **server-side** in
  `lib/roomsAuth.ts` (`page.tsx` is a server component; `RoomClient.tsx` is the
  client UI that receives only the safe claims). The token is stripped from the
  URL on load and never reaches client JS or logs. A missing/invalid token falls
  back to a clearly-labelled dev stub (`?name=`, untrusted).
- **Session lifetime**: the launch token is a short, single-use ticket (exp ~5 min).
  Middleware (`middleware.ts` → `lib/roomSession.ts`, Web Crypto on Edge) **exchanges
  it for a 6h room-issued session** at launch — same identity, re-signed with our
  key — so a player composing a prediction past the ticket's TTL stays signed in.
  Downstream Node routes verify that session with `roomsAuth`, unchanged.
- **Picks are private to this room — Rooms never sees a prediction.** On lock-in the
  pick is POSTed to our own `/pick` store (identity taken from the verified session
  cookie); the host gets only a contentless `postMessage({ type: "rooms:locked",
  ref, playerId })` and, at resolution, the scored board via `/close` (placement +
  rewards, never picks). The UI renders a required "Return to Rooms" link from the
  token's `returnUrl`.
- **Admin (result entry)**: `/admin/resolve` requires `Authorization: Bearer $ADMIN_TOKEN`.

## Environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `ROOMS_SIGNING_KEY` | always | HS256 secret from the Rooms `/developer` page. Interim: verifies the `?t=` launch token. Always: signs `/close`, verifies `/state`, and mints/verifies our 6h room session. Server-side only; never commit, never ship to the client. Without it, every player falls back to the dev stub. |
| `ADMIN_TOKEN` | for resolution | Bearer secret that gates `/admin/resolve`. Set in Vercel env, never commit. |
| `DATABASE_URL` | for durable picks | Neon connection string. Picks/results persist in `worldcup_*` tables (namespaced in the shared 1000Problems Neon; created idempotently, never collide with the host's `rooms_*`). Without it, `lib/store.ts` falls back to in-memory (local dev only — a cold start loses picks). |
| `ROOMS_ISSUER` | for ES256 cutover | Expected `iss` on the launch token (Rooms' canonical origin). Setting the three `ROOMS_*` ES256 vars switches launch verification from HS256 to ES256/JWKS. |
| `ROOMS_JWKS_URL` | for ES256 cutover | Rooms' `/.well-known/jwks.json`; source of the EC public keys we verify launch tokens against (no secret held on our side). |
| `ROOMS_ROOM_ID` | for ES256 cutover | Our room id from `/developer`; the launch token's `aud` must equal it (closes cross-room replay under the shared JWKS). |

## State machine (per match ref)

```
open  ──(manual lock OR now ≥ kickoff)──▶  locked  ──(admin posts result)──▶  closed
  ▲                                                                              │
  └──────────────────────────(admin reset wipes result + lock)──────────────────┘
```

`/phase` is the authority. `open` before kickoff, `locked` from kickoff (or a
manual `/admin/lock`) until a result is posted, `closed` once resolved, and back
to `open` on `/admin/reset`. `/phase` may read the clock; `/score` may not.

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
