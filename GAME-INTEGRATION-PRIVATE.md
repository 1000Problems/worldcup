# Private games — contract addendum for game authors

Companion to `GAME-INTEGRATION.md`. This is the **game-side half** of private
games, implemented in the third-party game's own repo (not PickCity). The wire
stays "Rooms": `roomId`, `X-Rooms-*`, `/api/rooms/close` are unchanged.

A private game is just **another `roomId`** played by an invited group, over the
**same game** (same schedule, same results) as your public game. PickCity creates
it locally and never calls you at creation time — you find out a private room
exists the first time one of its members launches in. Your job: treat every
`roomId` you've never seen as a fresh, isolated room of your own game.

If you do nothing, your game simply won't support private games — and PickCity
won't even offer the button (see the capability flag below). That's a fine
default.

## 1. Advertise support in `/contract`

PickCity reads `/contract` on every lobby render. Add one field:

```json
{ "display": { "name": "Goal Rush", "blurb": "Predict · banter · win the room" },
  "series": { "ref": "world-cup-2026-spain" },
  "allowsPrivate": true }
```

`allowsPrivate: true` is the **only** thing that makes PickCity show a "Create
private game" button on your tile. Omit it (or set false) and the feature is
hidden for your game. No handshake, no extra endpoint.

## 2. Treat any unknown `roomId` as a private instance of yourself

When a launch token arrives with a `roomId` you don't recognize, create an
isolated room on the spot, over your **existing** schedule:

- **Per `roomId`** (isolated): picks, leaderboard, chat, the room's winner.
- **Shared across all rooms** (your public room + every private room): the event
  list, `expectedLockAt` lock times, and real-world results. Because lock and
  resolve are properties of the event, a private room locks and resolves in
  lockstep with the public room for free.

You don't need PickCity to tell you the schedule — it's your own game; you already
know your events. Your roster builds itself: each member arrives via a launch
token carrying their `playerId` pseudonym and `displayName`. Show whoever has
launched into that `roomId`.

`GET /series/{ref}` stays room-agnostic (the shared schedule). `GET /state` and
`/close` are already room-scoped via `roomId` — keep using it.

## 3. Fan-out `/close` — one push per room

This is the main new burden. When an event (or the series) resolves, it resolves
for **every** room playing your game. Push `POST /api/rooms/close` once per room:

- one push for the public room, plus one for each private room;
- each push carries that room's own `roomId` and its own room-scoped board /
  standing (computed from that room's picks);
- same signing as today (HMAC over the raw body), same `playerId` pseudonyms you
  received in that room's launch tokens.

Enumerate "your rooms" from the `roomId`s you've seen launch in, plus your
original public room.

> The custom trophy name a creator sets ("Losers buy dinner at Denny's") is owned
> and minted by PickCity. You don't store or echo it. If you want to show it
> in-room, that's optional polish PickCity can pass on launch later — not required.

## Checklist

- [ ] `/contract` returns `allowsPrivate: true`.
- [ ] An unknown `roomId` auto-creates an isolated room over your existing
      schedule (idempotent — a repeat launch is a no-op).
- [ ] Picks / leaderboard / chat keyed by `roomId`; schedule + results shared.
- [ ] On every resolution, `/close` is pushed once per room with that room's
      `roomId` and board.
- [ ] No change to `roomId` echoing, `playerId` pseudonyms, or the `X-Rooms-*`
      signing you already implement.
