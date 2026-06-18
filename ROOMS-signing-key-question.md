# Request to Rooms: launch-token verification that doesn't depend on who's logged in

We're integrating a third-party room (World Cup Match Predictor) and we're going to
open it to the public. We need the room to authenticate **every** player the same way,
independent of which Rooms account is logged in. The current launch-token model couples
verification to the logged-in account, and that won't survive a public launch. This
note states the requirement and the two standard designs that would satisfy it; we'd
like Rooms to support one of them.

## The requirement

Two things have to be cleanly separated:

- **Player identity** (playerId, displayName) comes from the launch token's claims and
  naturally varies per player. That's expected and we want it.
- **The trust anchor we verify against** must be a single, stable, room-level credential
  that Rooms controls. It must **not** vary with the player or the developer who happens
  to be logged in, and verifying it must not require us to hold a per-user secret.

In short: any player's launch token must verify against the same room-level trust
anchor, every time, no matter who they are.

## Why today's model fails the requirement

Rooms opens our room at `https://…/?t=<token>`, an HS256 JWT. HS256 is a **symmetric
shared secret** — the same key signs and verifies. Your `/developer` page hands that
secret out, and in testing it is scoped to the **logged-in developer account**: two
different accounts see two different keys, so a token minted under account B fails
verification against account A's key, which is the only one we can store. The secret is
therefore tied to who's logged in. We can't ship a public game on a trust anchor that
changes with the account.

## Two designs that meet the requirement

**Option 1 — Asymmetric tokens + published JWKS (our preference).**
Rooms signs launch tokens with a private key it never shares (RS256 or ES256) and
publishes the matching **public** key at a stable JWKS endpoint, with a `kid` in each
token header. We verify any player's token against that public key. We hold no secret;
nothing depends on the logged-in account; key rotation is handled by `kid`/JWKS lookup
with an overlap window. This is the standard OIDC ID-token pattern and is the cleanest
fit for a public, multi-player room.

What we'd need from Rooms: a stable issuer (`iss`), a stable JWKS URL, the signing
algorithm, and the `kid` convention.

**Option 2 — Token introspection / session-validation endpoint.**
The `?t=` value is opaque. Our room calls a Rooms API to exchange it for verified player
claims, authenticating that call with **our room's own client credentials** — issued
once to the room, not to any player. Trust depends on the room credential, not on the
player's session.

What we'd need from Rooms: an introspection/validation endpoint, the room client
credentials, and the claim shape returned.

Either option roots trust in a stable room-level credential and makes verification
independent of who's logged in. We prefer Option 1 because it's stateless, needs no
network call on the hot path, and is a well-trodden standard.

## What we're asking Rooms

1. Can Rooms sign launch tokens **asymmetrically** and publish a **public JWKS** for the
   room (Option 1)? If so, please share the issuer, JWKS URL, algorithm, and `kid`
   convention.
2. If not, can Rooms expose a **token-introspection / session-validation endpoint**
   authenticated by per-room client credentials (Option 2)? If so, please share the
   endpoint, the credential issuance flow, and the returned claim shape.
3. Either way: what is the **key/credential rotation** procedure, and is there an
   overlap window so in-flight launches don't fail during a rotation?
4. Confirm that whichever mechanism you provide is **room-level and player-agnostic** —
   the same trust anchor verifies every player's launch, regardless of which account is
   logged in.

## What would unblock us

A room-level, public (or introspection-based) verification path — one trust anchor per
room, no per-user secret, with documented rotation. Once we have that, our room verifies
every player the same way and we can open the game to the public.
