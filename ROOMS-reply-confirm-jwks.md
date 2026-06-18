# Reply to Rooms: confirming JWKS verification + one multi-room question

**Re:** "Rooms — launch-token verification for public, third-party rooms" (2026-06-17)

Thanks — this is exactly what we needed. Confirming our side and raising one wrinkle
specific to how our room is deployed.

## Confirmed

- **We'll verify via JWKS (Option 1).** Stateless ES256 verification against your
  published public key, no secret stored on our side. Our verifier will pin the
  algorithm to `ES256` and ignore the token's own `alg` header, check `iss`, check
  `aud` equals our room, and check `exp` with a small clock tolerance.
- **Rotation handled by JWKS, not by pinning.** We'll cache the JWKS, key by `kid`, and
  refetch once on an unknown `kid` before rejecting. Your publish-before-sign plus the
  ~10-minute overlap covers our in-flight launches.
- **Part 1 (promote to one live source):** please go ahead — it unblocks our testing
  immediately, and our current verifier already accepts the single stored key.
- **Part 2 (ES256 cutover):** we'll point the verifier at the JWKS URL and drop the
  stored shared secret at the switch. We'd like the **test token + live JWKS** you
  offered before the cutover so we can verify against the real endpoint ahead of public
  launch.
- The per-room HMAC key for host↔room **API** calls staying symmetric is fine — that's a
  separate seam and doesn't change here.

## One thing to resolve: we host the whole tournament from one deployment

Our room serves **every World Cup match from a single deployment** — each match is a
separate Rooms room (today: match-38, Spain vs Saudi Arabia), and one codebase routes by
match. That means each launch's `aud` is a **different** room id, not one fixed value, so
we can't verify `aud` against a single constant.

To handle that cleanly, please confirm:

1. **One Rooms room — one stable `aud` — per match?** i.e. each match we add is its own
   registration with its own room id, and that id is stable over the match's life.
2. **Can we treat the verified `aud` as the authoritative match selector?** If `aud`
   reliably identifies which match a token is for, we'd validate it against the set of
   room ids we've registered and use it to route the player to the right match — rather
   than trusting the subdomain. That also closes a routing item on our side.
3. **How do we enumerate our room ids?** Is there a list/endpoint of the room ids
   registered to us, or do we maintain that mapping ourselves as we add matches?

## Pending values we'll need before the switch

The final production `iss` and JWKS URL (both marked *(confirm)* in your note), and
confirmation the `kid` convention (`YYYY-MM` + suffix) is final. The `ES256` algorithm
and the claim shape you listed all work for us as-is.

Once we have the multi-room `aud` answer and the production `iss`/JWKS URL, we'll wire
the verifier and test against the live JWKS before you flip the live source to ES256.
