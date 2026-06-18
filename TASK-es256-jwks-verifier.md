# TASK: Verify launch tokens via ES256 + JWKS

> Replace the interim HS256 launch-token verification with stateless ES256-over-JWKS, so we verify every player's launch against Rooms' published public key and hold no minting secret. Only the launch token changes — `/state`, `/close`, and our room session stay HS256.

## Context

Today the launch `?t=` JWT is HS256, verified with the shared `ROOMS_SIGNING_KEY` (`lib/roomsAuth.ts`, and the Edge copy `verifyLaunch` in `lib/roomSession.ts`). The agreed target (`ROOMS-reply-confirm-jwks.md`, `SECURITY-PROPOSAL-launch-auth.md`) is **ES256 over a JWKS**: Rooms signs with a private key, we verify against its published public key, key-rotation by `kid`. A leak on our side then can't forge a launch.

Crucial scope line: **only the launch token goes asymmetric.** Our **room session** (the 6h cookie we mint at launch — `roomSession.mintSession`) stays HS256 with our own key, and the server-to-server seams (`/state` verify, `/close` sign) stay HS256 with `ROOMS_SIGNING_KEY`. So after this we hold the JWKS config *and* `ROOMS_SIGNING_KEY` — three env values total.

This supersedes the older `TASK-rooms-jwks-verification.md`, which predates the session-exchange and pick-ownership work now in place.

## Requirements

1. **Build the verifier** — `src/lib/launchVerifyAsym.ts`, using **Web Crypto** so the one module runs on both Edge (middleware) and Node (`page.tsx`):
   - Fetch the JWKS from `ROOMS_JWKS_URL`; cache keys by `kid` at module scope; on an unknown `kid`, refetch **once** (with a short cooldown so a bogus `kid` can't cause a fetch storm); apply a fetch timeout; **fail closed** if no key resolves.
   - Verify ES256 via `crypto.subtle.verify` (`{name:"ECDSA",hash:"SHA-256"}`) using the public key imported from the JWK (`{kty:"EC",crv:"P-256",x,y}`). Pin the algorithm to ES256 from config — never read the token header's `alg`.
   - Check `iss === ROOMS_ISSUER`, `aud === <our room id>`, and `exp` within ≤60s skew. Return verified claims, or a non-sensitive reason code (`no-config`, `unknown-kid`, `jwks-unreachable`, `bad-signature`, `wrong-iss`, `wrong-aud`, `expired`, `malformed`).
2. **Wire into middleware** — `middleware.ts` verifies the launch `?t=` with `launchVerifyAsym` (await) instead of the HS256 `verifyLaunch`, then mints the HS256 room session exactly as today (`roomSession.mintSession` is unchanged — that token is ours, symmetric).
3. **Wire into `page.tsx`** — first-render `?t=` is verified with `launchVerifyAsym` (the component is already async). Downstream reads (`/pick`, `/chat`) keep using the HS256 room-session cookie via `roomsAuth` — unchanged.
4. **Env + fallback** — add `ROOMS_ISSUER` and `ROOMS_JWKS_URL`. Keep `ROOMS_SIGNING_KEY` for `/state`, `/close`, and room-session mint/verify. During cutover, fall back to HS256 launch verification when the JWKS env is absent, so the room keeps working before Rooms flips; remove the HS256 **launch** path once cutover is confirmed.
5. **Exercise every rejection path** against a Rooms-provided test JWKS + production-signed test token before pointing at prod: valid token, tampered signature, wrong `iss`, wrong `aud`, expired, unknown `kid` (one refetch then resolve), and JWKS unreachable on a cold start (must fail closed — read-only, never open).

## Implementation Notes

- `crypto.subtle` exists in **Node 18+ and Edge**, so a single async Web Crypto module serves both runtimes — no duplicate node:crypto path, and no header-forwarding hack.
- ECDSA verify in Web Crypto expects the signature as **raw `R||S` (64 bytes)** — exactly what Rooms emits (`ieee-p1363`). No DER conversion.
- The JWKS is fetched server-side (Edge/Node), so **no CORS** concerns.
- Keep all key material and the raw token server-side; `page.tsx` passes only safe claims to `RoomClient`; the `?t=` strip on mount and `Referrer-Policy: no-referrer` stay.
- The room id to check `aud` against is a single value for v1 (one room) — read it from env or the session; do not enumerate a list.

## Do Not Change

- `lib/roomsAuth.ts` (HS256) — still used to verify the room session and is the cutover fallback; don't delete it.
- `roomSession.mintSession` — the room session stays HS256 (our own key); only the *launch* verification flips.
- `lib/roomsClose.ts`, the `/state` signature scheme, `/pick`, `/chat`, and the pure scorer in `lib/rooms.ts`.

## Acceptance Criteria

- [ ] A production-signed ES256 launch token signs a player in; tampered, wrong-`iss`, wrong-`aud`, and expired tokens are all rejected with the right reason code.
- [ ] An unknown `kid` triggers exactly one JWKS refetch, then resolves or rejects; a repeat bogus `kid` does not refetch within the cooldown.
- [ ] JWKS unreachable on a cold start ⇒ launches fail closed (no access), never accepted unverified.
- [ ] `ROOMS_SIGNING_KEY` still verifies `/state` and signs `/close`; the 6h room session still works past the launch token's TTL.
- [ ] `npx tsc --noEmit` and `npm run build` pass; `grep` shows no key material or raw token in the client bundle.

## Verification

1. `npx tsc --noEmit`.
2. With a test JWKS + test token, walk each rejection path with crafted tokens; confirm reason codes.
3. Confirm a normal launch → pick → resolve still works end to end (session, `/pick`, `/close`).
4. `npm run build`.

## Blocked on Rooms

Requirement 5 and cutover need, from `Rooms/TASK-es256-cutover-host.md`: the production `iss`, the JWKS URL, and a production-signed test token. Requirements 1–4 can be built and unit-tested now against a self-generated P-256 test key.
