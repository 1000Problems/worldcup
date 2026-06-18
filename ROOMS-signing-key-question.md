# Question for Rooms: which key signs player launch tokens in production?

We're integrating a third-party room (World Cup Match Predictor) and verifying the
signed launch token exactly as your guide describes. Before we open the game to the
public we need to confirm one thing about the signing key, because what we see on the
`/developer` page doesn't match the "one key per room" assumption the integration
doc sets up.

## What we built (per your spec)

Rooms opens our room at `https://…/?t=<token>`. We verify `t` server-side — HS256,
constant-time signature compare, `exp` check — using a single secret we copied from
the `/developer` page into our host's environment as `ROOMS_SIGNING_KEY`. A token that
verifies greets the player by their `displayName` and attributes their pick to their
`playerId`; a token that fails verification falls back to a signed-out state. This all
works: a launch from the account that owns the key signs in correctly.

Your integration guide says the key is shown on `/developer` "for your room" — i.e.
one key per room.

## What we actually observed

Testing with two browsers logged into **two different Rooms accounts**:

- Account A (Chrome): `/developer` shows key K-A. We put K-A in our environment.
  Launching the room as A → token verifies, player signs in. Correct.
- Account B (Brave): `/developer` shows a **different** key, K-B. Launching the room
  as B → the token is present but its signature is signed with K-B, so it fails
  verification against K-A. Player is rejected.

So in practice the key we're handed looks **scoped to the developer account**, not
stable per room. We can only store one `ROOMS_SIGNING_KEY` in our environment, so only
launches signed with that one key can ever verify.

## Why this blocks a public launch

When the game goes public, hundreds of ordinary players will open the room from the
Rooms app. None of them are developers; none of them see `/developer`. For the room to
open for **every** player, every player's launch token must be signed with the **one**
room key we hold — regardless of who the player is. If signing is tied to anything
per-user, most players would be rejected, which is unacceptable for a public game.

We assume the per-account difference we saw is an artifact of testing with two
*developer* accounts, and that real player launches are all signed with the single room
key. We need you to confirm that, not assume it.

## What we need confirmed

1. **Is there exactly one signing key per room**, and is **every** player's launch
   token — for any player, developer or not — signed with that single room key?
2. **The key on `/developer`:** is it the canonical, room-level key, or is it scoped to
   the viewing developer's account? If it's account-scoped, where do we read the
   canonical room key to put in our environment?
3. **Production player flow:** when a non-developer player opens the public room, which
   key signs their `t` token? Confirm it is the same key we store as
   `ROOMS_SIGNING_KEY`.
4. **Rotation and stability:** can the room key change over time — e.g. does viewing or
   refreshing `/developer` rotate it? If it can rotate, how are we notified so we can
   update the environment before tokens start failing? Is there a rotation/overlap
   window, or does a rotation immediately invalidate every in-flight launch?
5. **Multiple developers, one room:** if more than one developer account is attached to
   the same room, do they all see the same key? If not, which one is authoritative?

## What would unblock us

A single, stable, room-level signing key that signs all player launch tokens, with a
documented rotation procedure if rotation is possible. If the model is genuinely
per-account, we need a supported way to fetch and pin the canonical room key — because a
public room can't verify against a key that changes with the player.
