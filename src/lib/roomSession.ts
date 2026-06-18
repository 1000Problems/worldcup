// ---------------------------------------------------------------------------
// Room-issued session — Edge-safe (Web Crypto).
//
// The Rooms launch token (`?t=`) is a SHORT, single-use ticket — exp ~5 min,
// which is correct for a bearer token that rides in a URL. But a player composing
// a scoreline + goal-minute prediction can easily sit on the page longer than
// that, and if the only credential were the launch ticket, every /pick and /chat
// call would start 401-ing mid-match (the cookie would outlive the token it
// carries).
//
// So at launch we EXCHANGE the ticket for a room-issued session: verify the
// launch token's HS256 signature with our ROOMS_SIGNING_KEY, then re-issue the
// same identity claims with a 6h exp, signed with the same key. This runs in
// middleware, which is Edge-only (no node:crypto), so it uses Web Crypto. The
// resulting token is plain HS256 over the same key, so it still verifies in Node
// via roomsAuth.verifyRoomsSession — no second verification path downstream.
// ---------------------------------------------------------------------------

export const SESSION_TTL_S = 60 * 60 * 6; // 6h — covers pre-kickoff composing + the match

const enc = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export type SessionClaims = {
  playerId: string;
  displayName: string;
  avatarToken: string;
  returnUrl: string;
  roomId: string;
  iat: number;
  exp: number;
};

// Verify an HS256 launch token. Alg is pinned to HS256 — we never read the
// header's own alg (defeats alg-confusion / "alg:none").
export async function verifyLaunch(token: string, key: string): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  const expected = await hmac(key, `${h}.${p}`);
  let got: Uint8Array;
  try {
    got = b64urlToBytes(sig);
  } catch {
    return null;
  }
  if (!safeEqual(expected, got)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp + 60) return null;
  if (typeof claims.playerId !== "string" || typeof claims.displayName !== "string") return null;
  return claims;
}

// Re-issue the verified identity with a fresh 6h exp. This is OUR session, signed
// with our key — it lives only in an HttpOnly cookie, never in a URL.
export async function mintSession(claims: SessionClaims, key: string): Promise<{ token: string; maxAge: number }> {
  const now = Math.floor(Date.now() / 1000);
  const next: SessionClaims = { ...claims, iat: now, exp: now + SESSION_TTL_S };
  const header = b64urlFromBytes(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlFromBytes(enc.encode(JSON.stringify(next)));
  const sig = b64urlFromBytes(await hmac(key, `${header}.${payload}`));
  return { token: `${header}.${payload}.${sig}`, maxAge: SESSION_TTL_S };
}
