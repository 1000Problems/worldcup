# Build a Room for Rooms — Getting Started & API

This is everything you need to build a **room** (a Game) for the Rooms platform and connect it for development. Build it in any language, any framework, any database you like — Next.js, Rails, Go, Django, Phoenix, a single Express file, whatever. The only contract is the set of HTTP endpoints below, reachable at a public URL.

Use this doc two ways: read it to understand the platform, or prepend it to a coding agent and finish with *"now build me a room that does \<your game\>"* — it carries the full API as context.

---

## What a room is, and where the line is

A room is one **Game** behind a URL. You build the game; Rooms is the platform around it. The split, so you don't rebuild what the platform already gives you:

**Rooms owns (don't build these):**
- **Identity & login.** Players already have a Rooms account. When one enters your room, Rooms signs them in for you ("Login with Rooms" — §Identity). You never build signup, passwords, or "log in with Google."
- **The economy.** Trophies, experience (Renown), and badges are minted by Rooms, not by you. Your room *proposes* a reward; Rooms grants it (§Winnings). This is deliberate — it's what stops fake games from farming levels.
- **Lifecycle enforcement, the pick store, the audited scoreboard.** Rooms stores picks, freezes them at lock, and recomputes scores from your pure scorer.

**You own (this is your game):**
- What players pick, how it's validated, how it resolves, how it scores — and, if you want, the live view and the social space inside your room.

Everything below is the seam between the two.

## Pick any stack you want

There are **no restrictions** on how you build. Use a database, background jobs, a real-time feed, any framework — go wild. The platform only cares that:

1. Your service is reachable at a public HTTPS URL.
2. It answers the endpoints in the API section (as you grow into them — see *Connecting for development* for what's needed *today* vs *eventually*).
3. Responses are JSON in the shapes shown.

That's the whole constraint surface. Inside it, the room is yours.

## The API — endpoints your room exposes

`{base}` is your service's URL. These mirror the platform contract (`THIRD-PARTY-ROOMS.md`).

```
GET  {base}/contract                    → Manifest          # who you are; the host introspects this
GET  {base}/event/{ref}                  → EventDef          # the roster/options + advisory dates + labels
POST {base}/validate   {event, pick}     → Validation        # is this a legal pick (pure)
GET  {base}/phase/{ref}                   → PhaseSignal       # open | locked | closed — YOU are the authority
POST {base}/resolve    {ref}             → ResultDef | null  # fetch the real-world result (or null if members attest)
POST {base}/score      {result, picks[]} → ScoreBreakdown[]  # pure: (picks, result) → points. No IO, no clock, no randomness
POST {base}/rewards    {result, standings} → RewardProposal  # optional: trophy / xp / badges to propose
```

Two rules that matter: **`/score` must be pure** (same inputs → same outputs, no network/clock/random) so Rooms can re-run it to audit the board; and **`/phase` is your call** — lock happens when your game says "locked" (lights out, first serve, market open), not when a clock hits a time.

### `/contract` — the manifest (the one to build first)

```jsonc
{
  "id": "my-game",                 // stable, unique kind id
  "contractVersion": "1.0",
  "display": { "name": "My Game", "blurb": "One line players see.", "iconToken": "generic" },
  "roomShape": { "instancing": "instanced", "minPlayers": 2, "maxPlayers": 2 },
  //   instancing: "canonical" (one shared house event, many rooms — the F1 model)
  //            or "instanced" (each room authors its own event from a template — the bet model)
  "pickSchema": { "kind": "single-select", "options": "from-event" },
  //   Tier-1 primitives Rooms can render for you: ordered-list | single-select | multi-select | numeric | bracket
  "createSchema": { /* instanced only: the create form, e.g. proposition/date/sides/trophy */ },
  "capabilities": {
    "renderer": "declarative",     // "declarative" (Rooms renders pickSchema) OR "bespoke" (you ship the UI)
    "rendererUrl": null,           // set to a page URL iff renderer is "bespoke" (Rooms loads it in a sandboxed iframe)
    "liveState": false,            // do you emit a watchable feed while locked
    "resolution": "world-fed",     // "world-fed" (you read a real source) | "member-attested" (members confirm)
    "rewards": ["trophy"]          // which proposals /rewards returns; XP is always host-computed
  },
  "badgeCatalog": []               // every badge you can ever award, declared up front
}
```

### The other payloads (shapes)

```ts
EventDef       = { ref, options: Option[], expectedOpenAt?, expectedLockAt?, expectedResolveAt?, labels }
Validation     = { valid: boolean, reason?: string }
PhaseSignal    = { phase: "open"|"locked"|"closed", status: "scheduled"|"postponed"|"cancelled" }
ResultDef      = { /* your normalized result blob — opaque to the host */ } | null
ScoreBreakdown = { playerId, points, detail?: unknown }   // returned per player from /score
RewardProposal = {
  trophy?:   { publicLabel, iconToken },
  renownProposal?: { bonus: number, reason?: string },     // ADVISORY — Rooms caps & recomputes
  badges?:   [{ playerId, code }]                          // ADVISORY — code must be in badgeCatalog
}
```

## Identity — "Login with Rooms" (what you get about a player)

When a player enters your room, Rooms hands you a **signed session token**, not an account. You receive:

- `playerId` — stable for *your* game, so you recognize a returning player.
- `displayName`, `avatarToken` — so you can draw them and their friends.
- **nothing else** — no email, no contact, no login, no link to who they are in any other game.

So you can show who's in the room, run a chat, draw a live board with real names. You **cannot** email or reach players outside the room — contact stays with Rooms. Don't build your own login; verify the token against Rooms' public key and treat the player as signed in. *(Token verification details ship with the SDK; for early dev you can stub a player.)*

## Winnings — propose, don't mint

When your event resolves, your `/rewards` endpoint *proposes* a trophy, an experience bonus, and/or badges. Rooms validates, caps, and mints them onto the player's profile. You never write to a player's trophy shelf or level directly — you describe the outcome and let go. (Chat/presence is yours to build in v1; Rooms does not provide a chat layer to third-party rooms yet.)

## Connecting for development

**Today — register and open.** The dev connection is deliberately simple to start: deploy your room to a public URL, then in Rooms go to **/developer → Add a room in development**, paste the URL, and save. Clicking the room opens your deployed page. That's the loop that works now — it lets you build and view your room live against the platform. At this stage Rooms only needs your URL to resolve to a working page.

**As you build — implement the contract.** Stand up `/contract` first (it's how Rooms will introspect your game), then fill in `/event`, `/validate`, `/phase`, `/resolve`, `/score`, and optionally `/rewards`. As the platform grows to call these, a room that already answers them plugs straight in. Keep `/contract` returning valid JSON at all times — it's the handshake everything else hangs off.

**Quick local check (recommended ordering):**
1. Build the game logic you care about — picks, validation, scoring — in whatever stack you chose.
2. Expose `/contract` and confirm it returns valid JSON.
3. Deploy to a public HTTPS URL.
4. Register the URL in Rooms `/developer` and open it.
5. Iterate: add `/event`, `/phase`, `/resolve`, `/score`, `/rewards` as you go.

## If you're handing this to a coding agent

Prepend this whole document, then say: *"Build a Rooms room for \<describe the game: what players pick, how it scores, how it resolves\>. Use \<stack/database of choice\>. Implement the `/contract` endpoint now and stub the rest, deploy to a public URL, and give me the URL to register in Rooms /developer."* The agent has the full API above and is free to choose the technology.
