// ---------------------------------------------------------------------------
// Rooms session verification — SERVER ONLY.
//
// Rooms launches the room at `/?t=<token>`, a JWT signed HS256 with our room's
// signing key (ROOMS_SIGNING_KEY, from the Rooms /developer page). We verify the
// signature here, on the server, and hand only the safe claims to the client.
//
// SECURITY:
//   - This module reads ROOMS_SIGNING_KEY and MUST never be imported by a client
//     component. It uses node:crypto, which also won't bundle client-side.
//   - HS256 is hard-coded; we never trust the token's own `alg` header (defeats
//     alg-confusion / "alg:none" forgeries).
//   - Constant-time signature compare; reject on any mismatch, missing token, or
//     expiry (with a small clock-skew allowance).
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

export type RoomsPlayer = {
  playerId: string;
  displayName: string;
  avatarToken: string;
  returnUrl: string;
  roomId: string;
  iat: number;
  exp: number;
};

const b64urlToBuf = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function verifyRoomsSession(token: string | null | undefined): RoomsPlayer | null {
  const KEY = process.env.ROOMS_SIGNING_KEY;
  if (!KEY || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  // HS256 over `header.payload`, compared in constant time. We never read the
  // header's declared alg — we always HMAC-SHA256.
  const expected = createHmac("sha256", KEY).update(`${h}.${p}`).digest();
  let got: Buffer;
  try {
    got = b64urlToBuf(sig);
  } catch {
    return null;
  }
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  let claims: RoomsPlayer;
  try {
    claims = JSON.parse(b64urlToBuf(p).toString("utf8")) as RoomsPlayer;
  } catch {
    return null;
  }

  // One-time launch ticket: reject once expired (60s skew). The short life is
  // the main defence against a leaked token being replayed.
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp + 60) return null;

  if (typeof claims.playerId !== "string" || typeof claims.displayName !== "string") return null;
  return claims;
}
