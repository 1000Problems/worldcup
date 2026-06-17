# Verify the Rooms session in your room

When Rooms opens your room, it appends a **signed session token** to the URL. This prompt tells you how to verify it and read the player. Hand it to your coding agent ("add Rooms session verification to my room") or follow it by hand.

Why a token and not plain fields: anyone can type `?displayName=Angel` into a URL. The signed token lets your room *prove* the session really came from Rooms and wasn't tampered with — so you can trust the player's identity before you seat them, attribute picks, or show them in chat.

## What you receive

Rooms opens: `https://your-room.example.com/?t=<token>`

`<token>` is a **JWT signed HS256** with your room's **signing key**. Decoded, its payload is:

```jsonc
{
  "playerId":    "p_8f2a…",                 // stable per-room pseudonym (not the user's real Rooms id)
  "displayName": "Angel",
  "avatarToken": "",                         // avatar (URL or token); may be empty for now
  "returnUrl":   "https://rooms.app/developer", // link the player back here (required)
  "roomId":      "…",
  "iat":         1718640000,                 // issued-at (seconds)
  "exp":         1718640300                  // expires ~5 min later
}
```

## What you must do

1. **Get your signing key.** Rooms shows it on the **/developer** page for your room. Copy it into your room as a secret env var, e.g. `ROOMS_SIGNING_KEY`.
2. **Verify the token on the SERVER — never in the browser.** Verification needs the signing key, and the key must never reach client JavaScript. In Next.js, read and verify `t` in a server component or route handler, then pass only the safe claims (playerId, displayName, avatarToken) to the client.
3. **Reject bad tokens.** If the signature doesn't match, the token is missing, or `exp` has passed, treat the player as **not signed in**. (During local dev with no Rooms, fall back to a stub player.)
4. **Use the claims**, then **strip `?t=` from the URL** client-side (`history.replaceState`) so the token doesn't linger in history or get sent in `Referer`.
5. **Render a "Return to Rooms" link** pointing at `returnUrl`. This is required to go live.

## Verify it (Node / TypeScript, zero dependencies)

Standard HS256 — any JWT library works too (`jsonwebtoken`, `jose`), but you don't need one:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const KEY = process.env.ROOMS_SIGNING_KEY!; // from Rooms /developer — server-side only

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export type RoomsPlayer = {
  playerId: string; displayName: string; avatarToken: string; returnUrl: string; roomId: string; iat: number; exp: number;
};

export function verifyRoomsSession(token: string | null): RoomsPlayer | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = createHmac("sha256", KEY).update(`${h}.${p}`).digest(); // raw bytes
  const got = b64url(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null; // bad signature
  const claims = JSON.parse(b64url(p).toString("utf8")) as RoomsPlayer;
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp + 60) return null; // expired (60s skew)
  return claims;
}
```

Using it in a Next.js server component:

```tsx
export default async function Room({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const player = verifyRoomsSession(t ?? null);
  if (!player) return <p>Open this room from Rooms.</p>; // or a dev stub
  return <RoomClient player={{ playerId: player.playerId, displayName: player.displayName, avatarToken: player.avatarToken }} returnUrl={player.returnUrl} />;
}
```

## In any other language

The token is a JWT, `alg: HS256`. Verify with your platform's JWT library and your `ROOMS_SIGNING_KEY` as the HMAC secret, or do it manually: split on `.` into `header.payload.signature`; compute `HMAC_SHA256("<header>.<payload>", KEY)`; base64url-encode it; constant-time compare to `signature`; then check `exp`. Decode the payload (base64url JSON) for the claims.

## Don'ts

- Don't verify in the browser or ship `ROOMS_SIGNING_KEY` to the client.
- Don't trust the claims if verification fails — no signature, no player.
- Don't reuse a token past `exp` — it's a one-time launch ticket.
