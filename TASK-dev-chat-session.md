# TASK: Dev session minter — smoke-test chat without a full Rooms launch

> Add a token-gated endpoint that mints a valid `rooms_session` token for a fake
> player, so the chat write path (`/chat` POST, `/react`, `/ping`) can be tested
> by curl/CI without launching the room through the Rooms host.

## Context

Chat posting is gated by the signed `rooms_session` cookie, which is only minted
when the room is launched with a real `?t=` token (see `middleware.ts` +
`chatSession.ts`). That makes the chat read path curl-testable but leaves
send/react/presence only reachable through a genuine Rooms launch. This adds a
dev helper — same trust level and Bearer gate as the existing `/admin/*` routes
— that signs a short-lived token for an arbitrary test player, closing the
testing gap surfaced while verifying the Banter Box backend.

## Requirements

1. **A signer that mirrors the verifier.** Add `signRoomsSession(claims, ttlSec)`
   to `src/lib/roomsAuth.ts` that produces an HS256 JWT over `header.payload`
   using `ROOMS_SIGNING_KEY` and the *same* base64url encoding the existing
   `verifyRoomsSession` expects — so a freshly minted token round-trips through
   verify. Do not modify the verify logic; only add the mint alongside it.
2. **Token-gated endpoint** `POST /admin/dev-session` mirroring the
   `/admin/resolve` Bearer gate: requires `Authorization: Bearer $ADMIN_TOKEN`
   (500 if `ADMIN_TOKEN` unset, 401 on mismatch) and 500 if `ROOMS_SIGNING_KEY`
   is unset. Body `{ playerId?, displayName?, returnUrl? }` with sensible test
   defaults (e.g. `dev-<random>`, `"Tester"`).
3. **Return the token for curl AND set the cookie.** Respond
   `{ token, playerId, displayName, expiresIn }` and also send `Set-Cookie:
   rooms_session=<token>` with the same attributes middleware uses
   (HttpOnly, Secure, SameSite=None, Path=/). Short TTL (≤ 1h).
4. **Verifiable round-trip.** A token from this endpoint must satisfy
   `getChatSession()` on the chat routes, so `POST /chat/{ref}` with
   `Cookie: rooms_session=<token>` inserts a message attributed to that test
   player and it shows up in `GET /chat/{ref}`.
5. **Containable in production.** Gate the whole endpoint behind an opt-in env
   flag `DEV_SESSION_ENABLED=1` (in addition to the Bearer gate) so it returns
   404 unless explicitly enabled — it can mint any identity, so it must be off by
   default even on the live deploy. Document `DEV_SESSION_ENABLED` in `CLAUDE.md`.

## Implementation Notes

- **Files** — modify: `src/lib/roomsAuth.ts` (add `signRoomsSession`, keep verify
  untouched). Create: `src/app/admin/dev-session/route.ts`. Update `CLAUDE.md`
  (endpoint table + env table). No new dependencies — use `node:crypto`
  (`createHmac`) exactly as the verifier does.
- **Signer shape** — reuse the verifier's claim type (`RoomsPlayer`): set
  `iat = now`, `exp = now + ttlSec`, and a fixed `roomId`/`avatarToken` for the
  stub. Header `{ alg: "HS256", typ: "JWT" }`; sign `b64url(header) + "." +
  b64url(payload)` and append `"." + b64url(hmac)`. The verifier ignores the
  token's own `alg`, so keep the payload claims it reads (`playerId`,
  `displayName`, `avatarToken`, `returnUrl`, `roomId`, `iat`, `exp`).
- **Auth guard** — copy the guard from `src/app/admin/resolve/route.ts`
  verbatim (Bearer check + 500/401 paths) plus the `DEV_SESSION_ENABLED` 404
  short-circuit and `OPTIONS` via `preflight()`.
- **Never log or echo secrets** — the response carries the minted JWT (that's the
  point), but never include `ADMIN_TOKEN` or `ROOMS_SIGNING_KEY` in any response
  or log line.

## Do Not Change

- `verifyRoomsSession` in `src/lib/roomsAuth.ts` — add the signer beside it; the
  verify path, HS256 hard-coding, and constant-time compare stay exactly as-is.
- `src/lib/chatSession.ts`, `middleware.ts`, the `/chat/*` handlers — this token
  must work with them unchanged; if it doesn't, the signer is wrong, not them.
- `scorePicks` / the pure scorer, and all other `/admin/*` and contract routes.
- The cookie attributes used by `middleware.ts` — match them, don't redefine them.
- No new npm dependencies.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] With `DEV_SESSION_ENABLED` unset, `POST /admin/dev-session` returns 404 even
      with a valid token.
- [ ] With the flag on: no token → 401; valid token → `{ token, … }` and a
      `Set-Cookie: rooms_session=…` header.
- [ ] `curl` flow works: mint a token, then `POST /chat/match-38` with
      `Cookie: rooms_session=<token>` inserts a message that appears in
      `GET /chat/match-38?since=0` attributed to the test player.
- [ ] A wrong/corrupted token is rejected by `getChatSession` (chat POST → 401).
- [ ] `git diff` shows changes only in `roomsAuth.ts`, the new route, and
      `CLAUDE.md`.

## Verification

1. `npm run build`, then `next start` with `ADMIN_TOKEN=test`,
   `ROOMS_SIGNING_KEY=<dev key>`, `DEV_SESSION_ENABLED=1`, `DATABASE_URL=<neon>`.
2. ```bash
   BASE=http://localhost:3000; AUTH="Authorization: Bearer test"
   TOKEN=$(curl -s -X POST $BASE/admin/dev-session -H "$AUTH" \
     -H 'content-type: application/json' -d '{"displayName":"Tester"}' | jq -r .token)
   curl -s -X POST $BASE/chat/match-38 -H 'content-type: application/json' \
     -H "Cookie: rooms_session=$TOKEN" -d '{"body":"hello from curl"}'
   curl -s "$BASE/chat/match-38?since=0"   # message present, display_name "Tester"
   ```
3. Confirm 404 when `DEV_SESSION_ENABLED` is unset, and 401 with no Bearer token.
4. `git diff --stat` — only the three files above.
