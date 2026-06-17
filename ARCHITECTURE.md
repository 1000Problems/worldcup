# Architecture — World Cup Predictor as a multi-game Rooms service

> One codebase, one deployment, many games. Each match gets its own URL, its own
> room, its own chat, scoreboard, and winner — while sharing a single database
> partitioned logically per game.

This document is the reference for how the service scales from the seeded
Spain–Saudi room to the whole tournament. It records decisions already made;
`TASK-cascade-scoring.md` covers the scoring rebuild, and `CLAUDE.md` describes
the current (single-match, no-DB) state of the code.

## The three layers

The design only stays clean if these are kept distinct:

- **Deployment** — the running code. There is exactly **one** Vercel deployment of
  the `1000Problems/worldcup` repo. It serves every game.
- **Event (`ref`)** — a real-world match, e.g. `match-38` (Spain vs Saudi Arabia).
  Canonical, shared truth: the fixture, kickoff, lock time, and final score. One
  per match.
- **Room (`roomId`)** — a Rooms instance where a group plays an event. The *social
  space*: its own players, chat, scoreboard, winner.

`ref` identifies the match. `roomId` identifies the separate experience. We are
running **one room per match**, so `roomId = ref` today — but every table that
holds social state carries a `room_id` column regardless, so allowing multiple
private rooms on one match later is a config change, not a migration.

## Ownership — Rooms vs. us

Rooms owns identity, the pick store, lock enforcement, and **the audited
scoreboard and winner, per room**. "Each game its own scoreboard and winner"
therefore needs nothing from us: every Rooms room has its own players and picks,
and Rooms recomputes standings from our pure `/score`. That partition is upstream.

We own, and must partition ourselves:

- **Chat / presence** — Rooms does not provide a chat layer to third-party rooms
  yet (per `PROMPT-new-room-project.md`). This is the main thing we store.
- **The match result** — the real-world score (and goal minutes, per the cascade
  task), entered via `/admin/resolve` and returned from `/resolve`.
- **Event config** — the fixture metadata and the URL slug.

We do **not** store picks, scores, or the winner. Rooms does.

## URLs and routing

One deployment, a distinct URL per game, no code or DB forking.

- **Slug** lives on the event: `events.slug`, built as `<round>-<home>-<away>`
  from FIFA tricodes. Round prefixes:

  | Round | Prefix | Example slug |
  |-------|--------|--------------|
  | Group stage | `gs-` | `gs-esp-ksa` |
  | Round of 32 | `r32-` | `r32-eng-fra` |
  | Round of 16 | `r16-` | `r16-bra-arg` |
  | Quarter-final | `qf-` | `qf-esp-ger` |
  | Semi-final | `sf-` | `sf-fra-por` |
  | Third place | `3p-` | `3p-ned-cro` |
  | Final | `final-` | `final-bra-fra` |

- **Domain**: a wildcard `*.worldcup.1000problems.com` points at the single Vercel
  project. GoDaddy carries one wildcard CNAME (`*.worldcup` → `cname.vercel-dns.com`);
  Vercel auto-issues SSL. A single-label slug like `gs-esp-ksa` sits under the
  one wildcard cert.
- **Resolution**: Next.js middleware reads the `Host` header, takes the leftmost
  label as the slug, looks up the `ref` in `events`, and renders that game. So
  `gs-esp-ksa.worldcup.1000problems.com` and `r16-bra-arg.worldcup.1000problems.com`
  are the same code and DB, different `ref`.
- **Path-based fallback**: `worldcup.1000problems.com/gs-esp-ksa` uses the same
  slug→ref lookup with no wildcard DNS. We can switch forms without touching data.

The `/contract` `rendererUrl` already derives from the request origin, so it stays
correct on the apex, a wildcard subdomain, or a raw `.vercel.app` URL.

## Data model — one Neon Postgres, logical partition

"Partitioned per game" means a **scoping column on shared tables in one database**,
not a database/schema/deployment per game. A DB-per-match would mean provisioning
104+ times, forks drifting apart, no tournament-wide view, and migrations × N.
Logical multi-tenancy gives the same "feels separate" — adding a game is an
`INSERT`, not infrastructure.

```sql
-- Shared truth, keyed by event ref
CREATE TABLE events (
  ref          TEXT PRIMARY KEY,        -- "match-38"
  slug         TEXT UNIQUE NOT NULL,    -- "gs-esp-ksa" (drives the URL)
  competition  TEXT NOT NULL,
  stage        TEXT NOT NULL,
  home_code    TEXT NOT NULL, home_name TEXT NOT NULL,
  away_code    TEXT NOT NULL, away_name TEXT NOT NULL,
  venue        TEXT,
  kickoff_utc  TIMESTAMPTZ NOT NULL     -- lock fires here
);

CREATE TABLE results (
  ref               TEXT PRIMARY KEY REFERENCES events(ref),
  home_goals        INT NOT NULL,
  away_goals        INT NOT NULL,
  home_goal_minutes INT[] NOT NULL DEFAULT '{}',
  away_goal_minutes INT[] NOT NULL DEFAULT '{}',
  outcome           TEXT NOT NULL,      -- derived: ESP | DRAW | KSA-style code
  final             BOOLEAN NOT NULL DEFAULT TRUE,
  resolved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Our tenant data: chat, partitioned by room
CREATE TABLE messages (
  id           BIGSERIAL PRIMARY KEY,
  room_id      TEXT NOT NULL,           -- partition key; = ref while one-room-per-match
  ref          TEXT NOT NULL REFERENCES events(ref),
  player_id    TEXT NOT NULL,           -- from the Rooms session token
  display_name TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_room_time ON messages (room_id, created_at DESC);

-- Optional per-room flavor (title, theme) if rooms customize
CREATE TABLE room_config (
  room_id    TEXT PRIMARY KEY,
  ref        TEXT NOT NULL REFERENCES events(ref),
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every chat read/write filters by `room_id`; every event/result read filters by
`ref`. That filter **is** the partition. Postgres row-level security can harden it
later, but scoped queries are enough to start. The match registry that lives in
`lib/rooms.ts` today migrates into the `events` table so new games are data.

## Chat (our feature)

Scope by `room_id`, render newest-N on load, append on send. Real-time delivery is
a separate, deferred decision — on Vercel serverless the realistic options are
short-poll, Server-Sent Events, or a managed realtime service (Ably / Pusher /
Supabase Realtime). The partition model is independent of whichever we pick.

## Lifecycle — launching a new game

1. `INSERT` an `events` row (ref, slug, teams, kickoff).
2. Point a Rooms room at that `ref` (Rooms `/developer`).
3. The URL exists immediately via the wildcard domain + slug lookup.

No new repo, deploy, or database.

## Integration unknowns to confirm with Rooms

- **Does Rooms hand the renderer a stable `roomId`** (via the iframe URL or the
  postMessage handshake)? Needed only if we later split multiple rooms per match;
  until then we scope chat by `ref`.
- **How the session token reaches our page** for chat identity (`playerId`,
  `displayName`) — stubbed in dev today; the SDK ships verification.
- **Whether Rooms exposes per-room presence** or we derive it from chat activity.

## Build phases

1. **Scaffold (done).** Single match, no DB, all seven contract endpoints + bespoke
   UI. Enough to register a Rooms dev instance.
2. **Cascade scoring** (`TASK-cascade-scoring.md`). Structured scoreline + goal
   minutes, band-encoded scorer. Still single-match.
3. **Multi-game routing + Neon.** Move the match registry into `events`, add slug
   middleware, wire the wildcard domain, swap the in-memory result store for
   `results` in Postgres.
4. **Chat.** `messages` table, room-scoped read/append, a realtime transport.

## Environment variables

| Name | Phase | Purpose |
|------|-------|---------|
| `ADMIN_TOKEN` | 1+ | Bearer secret gating `/admin/resolve`. |
| `DATABASE_URL` | 3+ | Neon Postgres connection string. Set in Vercel env, never committed. |

Secrets are referenced by name only and live in Vercel's environment settings.
