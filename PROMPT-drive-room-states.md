# Drive a room through its lifecycle (for Rooms-side testing)

This room — **World Cup Match Predictor** — exposes test controls so you can move it
through every lifecycle state on demand and watch the Rooms host react, without
waiting for the real match kickoff. Use it to develop and verify the host side:
state display in the lobby, lock enforcement, and the winner/reward payload.

Live room: `https://group-spain-saudi.worldcup.hadmoney.com`

## The state machine

```
open  ──(lock OR kickoff)──▶  locked  ──(resolve)──▶  closed
  ▲                                                      │
  └──────────────────(reset wipes result + lock)─────────┘
```

`GET /phase/{ref}` is the authority Rooms reads:

| Phase | Meaning | How to get there |
|-------|---------|------------------|
| `open` | Lobby is live, players make/change picks | default before kickoff; or after **reset** |
| `locked` | Picks frozen | **Lock** button, or real kickoff time |
| `closed` | Result is in, winner computable | **Resolve** button |

`ref` for the seeded match is `match-38`.

## Two ways to drive it

### 1. The `/dev` console (manual)

Open `https://group-spain-saudi.worldcup.hadmoney.com/dev`. Paste the room's
`ADMIN_TOKEN` (kept in your browser only), then use the three buttons in order:

1. **Lock picks** → phase goes `locked`.
2. **Resolve — Spain 1–0 (goal 10′)** → phase goes `closed`; a fixed, known result is posted.
3. **Reset to scratch** → phase back to `open`, result wiped.

The page shows the live phase and the current `/resolve` payload so you can watch
each transition.

### 2. The raw endpoints (programmatic / CI)

All three are gated by `Authorization: Bearer $ADMIN_TOKEN`.

```bash
BASE=https://group-spain-saudi.worldcup.hadmoney.com
AUTH="Authorization: Bearer $ADMIN_TOKEN"

# lock
curl -s -X POST $BASE/admin/lock  -H "$AUTH" -H 'content-type: application/json' -d '{"ref":"match-38"}'
# resolve to the canned scenario (Spain 1–0, goal at minute 10)
curl -s -X POST $BASE/admin/resolve -H "$AUTH" -H 'content-type: application/json' \
  -d '{"ref":"match-38","homeGoals":1,"awayGoals":0,"homeGoalMinutes":[10],"awayGoalMinutes":[]}'
# reset
curl -s -X POST $BASE/admin/reset  -H "$AUTH" -H 'content-type: application/json' -d '{"ref":"match-38"}'

# observe (no auth needed):
curl -s $BASE/phase/match-38
curl -s -X POST $BASE/resolve -H 'content-type: application/json' -d '{"ref":"match-38"}'
```

`/admin/lock` and `/admin/reset` return `{ ref, phase }`. `/admin/resolve` returns
the `ResultDef`.

## What Rooms reads when the room is `closed`

After **Resolve**, the host computes the winner from these (all unauthenticated):

- `POST /resolve { ref }` → the normalized result:
  ```json
  { "ref":"match-38","homeGoals":1,"awayGoals":0,"outcome":"HOME",
    "homeGoalMinutes":[10],"awayGoalMinutes":[],"final":true }
  ```
- `POST /score { result, picks[] }` → **pure** per-player points. Ranking is a
  magnitude-banded cascade in one scalar: outcome (1,000,000) + score closeness
  (0–9,999, exact tops it) + goal-minute closeness (0–99). Re-runnable for audit.
- `POST /rewards { result, standings }` → trophy + badge proposal; `winners[]` are
  the players tied at the top score (shared win).

With the canned 1–0/10′ result, a player who predicted exactly `1-0` with the goal
at `10'` tops the board; right-outcome-but-wrong-score ranks below; wrong outcome
ranks below that.

## Reset semantics — read this

**Reset wipes only this room's state** — the posted result and the manual lock.
It does **not** clear the picks, because Rooms owns the pick store. A true
from-scratch reset is two halves: this room's Reset *plus* whatever reset the host
performs on its own pick/scoreboard store.

## Auth

The control endpoints use the room's `ADMIN_TOKEN` (server-side env var, separate
from the Rooms signing key). The `/dev` page is public but inert without the
correct token — the gate is on the endpoints. Read-only endpoints (`/phase`,
`/resolve`, `/score`, `/contract`, `/event`) need no auth.
