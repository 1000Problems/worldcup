# TASK: Verify the Rooms session token (server-side identity)

> Replace the untrusted client-side identity guess with server-side verification of the signed Rooms launch token, so players can't be impersonated.

## Context

Rooms hands identity by appending `?t=<token>` to our room URL — a JWT signed HS256 with a per-room signing key (full spec in `PROMPT-verify-rooms-session.md`). Today `src/app/page.tsx` is entirely `"use client"` and reads `displayName`/`playerId` from query params and postMessage — which trusts unsigned input, so anyone can type `?displayName=Angel` and be treated as that player. This task moves verification to the server, where the signing key lives, and passes only verified claims to the client. The security analysis we agreed on: forgery is defeated only if (a) we verify server-side and (b) the key never reaches the client or logs. Honor both.

This pairs with the host→ref routing (`ARCHITECTURE.md`) because both belong in the same new server entry point, but keep this task scoped to identity — routing is a separate task.

## Requirements

1. **Server-only verifier.** Add `src/lib/roomsAuth.ts` exporting `verifyRoomsSession(token: string | null): RoomsPlayer | null`, the zero-dependency HS256 verify from `PROMPT-verify-rooms-session.md` (HMAC-SHA256 over `header.payload`, constant-time compare, `exp` check with ≤60s skew). It must hard-code HS256 and never read the token's own `alg` header. Reads `process.env.ROOMS_SIGNING_KEY`. This file must never be imported by a client component.

2. **Server component does the verification.** Convert `src/app/page.tsx` to a server component that reads `searchParams.t`, calls `verifyRoomsSession`, and renders a new client component `src/app/RoomClient.tsx` (the current UI, moved) with props `{ player: { playerId, displayName, avatarToken } | null, returnUrl: string | null }`. The raw token and the signing key must never be passed to the client.

3. **Token hygiene.** On mount, `RoomClient` strips `?t=` from the URL via `history.replaceState`. Add a `Referrer-Policy: no-referrer` response header so the token can't leak via `Referer`. Never log the raw token server-side, and in the debug panel show only a masked form (e.g. `present (…last4)`), never the full token or any query value named `t`.

4. **Trusted vs stub identity.** If the token verifies, greet the player and use the verified `playerId` when handing a pick to the host. If it's missing or invalid, fall back to a **clearly-marked dev stub** (the existing `?name=` override is allowed but flagged untrusted in the UI/debug) and still render the room. Drop the old postMessage/query session-harvesting as the identity source — the token is now the source of truth.

5. **Return to Rooms link.** When a verified `returnUrl` is present, render a "Return to Rooms" link to it (required by Rooms to go live).

## Implementation Notes

**Files** — create: `src/lib/roomsAuth.ts`, `src/app/RoomClient.tsx`. Modify: `src/app/page.tsx` (→ server component), `next.config.js` (Referrer-Policy header), `CLAUDE.md` (auth model + env var). The debug panel moves into `RoomClient` and is updated per requirement 3.

**Verifier** (from the Rooms prompt — keep it dependency-free):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
const KEY = process.env.ROOMS_SIGNING_KEY!; // server-side only
const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export type RoomsPlayer = {
  playerId: string; displayName: string; avatarToken: string;
  returnUrl: string; roomId: string; iat: number; exp: number;
};

export function verifyRoomsSession(token: string | null): RoomsPlayer | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = createHmac("sha256", KEY).update(`${h}.${p}`).digest();
  const got = b64url(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const claims = JSON.parse(b64url(p).toString("utf8")) as RoomsPlayer;
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp + 60) return null;
  return claims;
}
```

**Server page shape:**

```tsx
export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string; ref?: string; name?: string }> }) {
  const sp = await searchParams;
  const player = verifyRoomsSession(sp.t ?? null);
  return <RoomClient player={player ? { playerId: player.playerId, displayName: player.displayName, avatarToken: player.avatarToken } : null}
                     returnUrl={player?.returnUrl ?? null} devName={sp.name ?? null} />;
}
```

`RoomClient` keeps the existing match fetch, scoreline + goal-minute pick builder, submit/postMessage, and the debug panel — only the identity source changes (props in, not query/postMessage). Mark `export const dynamic = "force-dynamic"` so `searchParams` is read per request.

**Env var:** `ROOMS_SIGNING_KEY` — copied from the room's Rooms `/developer` page, set in Vercel (Production) as an encrypted env var. Document it by name only; never commit a value. Open question to resolve when fetching it: whether the key is **per-room** (then the multi-game build needs a key per ref) or **per-developer** (one key). For now a single `ROOMS_SIGNING_KEY` is fine for match-38.

## Do Not Change

- `src/lib/rooms.ts` scoring — `/score` stays pure; this task is identity only.
- `/score`, `/validate`, `/event`, `/phase`, `/resolve`, `/rewards`, `/admin/resolve` route handlers — endpoints are not identity-gated and don't change here.
- The canonical, ref-parameterized model and `/contract`'s origin-derived `rendererUrl`.
- The CORS `Access-Control-Allow-Origin: *` and the absent `X-Frame-Options` (iframe embedding must keep working) — only add `Referrer-Policy`.
- No new npm dependencies — verification is zero-dependency `node:crypto`.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] `ROOMS_SIGNING_KEY` is read only in server code; `grep -r ROOMS_SIGNING_KEY src` shows no occurrence in any `"use client"` file, and it does not appear in the client bundle.
- [ ] A token signed with the correct key verifies and the UI greets that `displayName`; a token with a tampered payload or wrong key is rejected and the room shows the dev-stub / "open from Rooms" state.
- [ ] An expired token (`exp` in the past beyond 60s skew) is rejected.
- [ ] After load, the address bar no longer contains `?t=`, and responses carry `Referrer-Policy: no-referrer`.
- [ ] The debug panel never displays the full token (masked only), and `/`'s server logs do not print the raw token.
- [ ] A verified session renders a working "Return to Rooms" link to `returnUrl`.
- [ ] `git diff` shows changes only in the files listed under Implementation Notes.

## Verification

1. `npm run build`, then `next start` with a test `ROOMS_SIGNING_KEY`.
2. Mint a test token locally with the same key (HS256) and open `/?t=<token>` — confirm the greeting, the stripped URL, and the Return link.
3. Flip one character in the token — confirm rejection (stub state).
4. Set `exp` to the past — confirm rejection.
5. `grep -rn ROOMS_SIGNING_KEY src` and inspect `.next` to confirm the key isn't in client output.
6. Check response headers for `Referrer-Policy: no-referrer`.
