# Security Proposal: Launch-Token Authentication (ES256 + JWKS)

**Status:** Accepted, blocked on Rooms for production values
**Date:** 2026-06-18
**Owner:** World Cup Match Predictor (third-party Rooms room)
**Supersedes:** the HS256 shared-secret launch path in `src/lib/roomsAuth.ts`
**Related:** `ROOMS-reply-confirm-jwks.md` (the reply we sent), `TASK-rooms-jwks-verification.md` (the build), `ARCHITECTURE.md` (host→ref routing)

## Summary

Rooms is moving player launch tokens off a per-registration HS256 shared secret onto
platform-level **ES256** signing with a published **JWKS**. We accept Option 1: stateless
asymmetric verification against Rooms' public key, with **no secret stored on our side**.
The one wrinkle is our deployment shape — one codebase serves every match, each match is
its own Rooms room — which makes `aud` a per-match value rather than a constant, and turns
the room-id allowlist from a convenience into a security requirement.

## Why this changes

Today `roomsAuth.ts` verifies an HS256 token with `ROOMS_SIGNING_KEY`, a symmetric secret
both sides hold. That secret is the single weakest point: if it leaks on our side, anyone
can forge a valid launch token for our room. ES256 removes it — Rooms holds the private
key, we hold only their public key fetched from a JWKS, so a compromise on our side can no
longer mint tokens, and Rooms can rotate keys without touching us.

## Decision

Verify launch tokens with **ES256 against the Rooms JWKS**, and gate every token on an
**allowlist of our own room ids**. Concretely, a token is accepted only if all hold:

- signature valid under the EC public key resolved by the token header `kid`;
- algorithm is **ES256**, taken from our config, never from the token's own `alg` header
  (defeats alg-confusion and `alg:none` forgeries);
- `iss` equals our configured Rooms issuer;
- `aud` is present, a single string, and a member of our registered room-id allowlist;
- `exp` is valid within a small clock-skew tolerance (≤60s until Rooms confirms).

Anything else fails closed. If the allowlist is unset or empty, **every** token is
rejected — we never fall open.

### The allowlist is load-bearing, not optional

Under a shared JWKS, every third-party room verifies against the *same* Rooms public key.
So signature validity alone no longer proves a token was minted for *us* — a validly
signed token issued for another room would otherwise pass. Checking `aud` against the set
of room ids registered to us is what closes that cross-room bypass. This is the central
security property of the proposal, and the reason we need Rooms to hand us the room-id
list (see Open items).

### One deployment, many rooms

We run the whole tournament from a single deployment; each match (today: match-38, Spain
vs Saudi Arabia) is a separate Rooms room with its own id. So each launch's `aud` differs.
Rather than fight that, we lean into it: the verified `aud` becomes the authoritative
match selector, replacing the subdomain-based routing sketched in `ARCHITECTURE.md`. The
`aud` lives inside the signed payload, so it's tamper-proof in a way a Host header is not —
this is strictly the safer routing key. (Wiring that routing is a *separate* task; the
verification work only enforces the allowlist gate.)

## Implementation shape

- **Zero new dependencies.** ES256 + JWKS handling is hand-rolled on `node:crypto` +
  global `fetch`, consistent with the existing verifier and the project's no-new-deps rule.
  One sharp edge: the JWS signature is raw `R||S` (64 bytes), not DER, so `node:crypto`
  must verify with `dsaEncoding: "ieee-p1363"` or it silently always fails.
- **JWKS cache.** Module-level, keyed by `kid`, persists across requests on a warm lambda.
  On an unknown `kid`, refetch the JWKS exactly once before rejecting, with a short
  cooldown so a bogus `kid` can't trigger a refetch storm.
- **Server-only invariants hold.** Key material, the JWKS, and the raw token never reach
  the client. `page.tsx` (a server component) passes only the safe claims — `playerId`,
  `displayName`, `avatarToken`, `returnUrl` — to `RoomClient`. The `?t=` is still stripped
  from the URL on mount; responses keep `Referrer-Policy: no-referrer`.
- **Diagnosable rejections.** The verifier returns a non-sensitive failure reason
  (`no-config`, `malformed`, `jwks-unreachable`, `unknown-kid`, `bad-signature`,
  `wrong-iss`, `wrong-aud`, `expired`, `missing-claims`) surfaced in the debug panel, so
  production rejections are debuggable without ever exposing the token or keys.

Full requirements, target signatures, and acceptance criteria live in
`TASK-rooms-jwks-verification.md`. That task is **blocked** until the values below arrive.

## Environment variables

| Name | Replaces | Purpose |
|------|----------|---------|
| `ROOMS_ISSUER` | — | Expected `iss`; reject any token not from this issuer. |
| `ROOMS_JWKS_URL` | — | Production `.well-known/jwks.json`; source of EC public keys by `kid`. |
| `ROOMS_ROOM_IDS` | — | Comma-separated allowlist of our registered room ids; checked against `aud`. Empty ⇒ reject all. |
| `ROOMS_SIGNING_KEY` | *(retired from launch path)* | Kept documented only for the future host↔room API seam, which stays symmetric. |

## Open items — blocked on Rooms

We cannot finalize the cutover until Rooms confirms:

1. **One stable `aud` per match**, and that `aud` is a single string (not an array).
2. That the verified `aud` may serve as our authoritative **match selector** (routing).
3. **The list of room ids registered to us, and how we fetch/refresh it** — required to
   populate the allowlist. This is blocking, not convenience.
4. **`aud` vs `roomId`** — the token carries both; which is authoritative for identifying
   the room? The build gates on `aud`; revisit if Rooms says `roomId`.
5. Final production **`iss`** and **JWKS URL**, and that the `kid` convention is final.
6. **`exp`/`iat` semantics and acceptable clock skew**, so our test-token check matches
   production.
7. A **production-signed test token**, so we can verify the full live chain before cutover.

## Rollout

1. **Part 1 — promote to one live source (Rooms, now).** Unblocks our testing; our current
   verifier already accepts the single stored key.
2. **Wire behind env vars (us).** Land `TASK-rooms-jwks-verification.md` with values stubbed
   from a Rooms-provided test JWKS; exercise every rejection path.
3. **Verify against the live JWKS (us).** Using the production-signed test token, confirm
   the full chain — signature, `iss`, `aud` allowlist, `exp` — before public launch.
4. **Part 2 — ES256 cutover (Rooms).** Point the verifier at the production JWKS URL and
   drop `ROOMS_SIGNING_KEY` from the launch path at the switch.

## Risks and mitigations

- **Cross-room token replay** → allowlist gate on `aud`; fail closed on empty allowlist.
- **Alg-confusion / `alg:none`** → algorithm pinned to ES256 from config, token `alg`
  header ignored.
- **JWKS unreachable at verify time** → cache persists across warm requests; unknown-`kid`
  refetch is one-shot with a cooldown. A cold start with the JWKS down rejects (fail
  closed) rather than accepting unverified tokens.
- **Key rotation mid-launch** → Rooms' publish-before-sign plus the ~10-minute overlap
  covers in-flight launches; we key by `kid` and refetch on miss.
- **Secret left in client bundle** → server-only modules, grep gate in acceptance criteria,
  `.next` bundle inspection.
