// ---------------------------------------------------------------------------
// Asymmetric launch-token verification — ES256 over a published JWKS.
//
// The target auth path (ROOMS-reply-confirm-jwks.md): Rooms signs the launch
// token with a private key it never shares and publishes the matching public key
// as a JWKS. We verify against that public key and hold NO minting secret, so a
// leak on our side can't forge a launch.
//
// Web Crypto only (`crypto.subtle`), which exists on BOTH the Edge runtime
// (middleware) and Node 18+ (page.tsx) — one module, both runtimes, no duplicate
// implementation. ECDSA P-256 verification takes the signature as raw R||S
// (64 bytes), exactly what Rooms emits (`ieee-p1363`) — no DER.
//
// Only the LAUNCH token is asymmetric. Our room session and the /state + /close
// seams stay HS256 with ROOMS_SIGNING_KEY.
// ---------------------------------------------------------------------------

import type { SessionClaims } from "@/lib/roomSession";

type LaunchClaims = SessionClaims & { iss?: string; aud?: string };

export type AsymReason =
  | "no-config"
  | "malformed"
  | "unknown-kid"
  | "jwks-unreachable"
  | "bad-signature"
  | "wrong-iss"
  | "wrong-aud"
  | "expired"
  | "missing-claims";

export type AsymResult = { claims: SessionClaims | null; reason?: AsymReason };

const JWKS_TIMEOUT_MS = 1500;
const REFETCH_COOLDOWN_MS = 30_000; // an unknown kid refetches at most this often
const EXP_SKEW_S = 60;

// Module-level cache — persists across warm invocations on both runtimes.
const keyByKid = new Map<string, CryptoKey>();
let lastFetchMs = 0;

export function isAsymConfigured(): boolean {
  return !!(process.env.ROOMS_ISSUER && process.env.ROOMS_JWKS_URL && process.env.ROOMS_ROOM_ID);
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Jwk = { kty?: string; crv?: string; x?: string; y?: string; kid?: string };

async function loadJwks(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JWKS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body?.keys)) return false;
    keyByKid.clear();
    for (const jwk of body.keys) {
      if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.kid) continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        keyByKid.set(jwk.kid, key);
      } catch {
        /* skip a malformed key, keep the rest */
      }
    }
    lastFetchMs = Date.now();
    return true;
  } catch {
    return false; // timeout / network / parse
  } finally {
    clearTimeout(timer);
  }
}

async function keyFor(kid: string, jwksUrl: string): Promise<{ key?: CryptoKey; reason?: AsymReason }> {
  let key = keyByKid.get(kid);
  if (key) return { key };

  // Unknown kid (cold cache or a rotation): refetch once, rate-limited.
  if (Date.now() - lastFetchMs > REFETCH_COOLDOWN_MS || keyByKid.size === 0) {
    const ok = await loadJwks(jwksUrl);
    if (!ok && keyByKid.size === 0) return { reason: "jwks-unreachable" }; // fail closed
    key = keyByKid.get(kid);
  }
  return key ? { key } : { reason: "unknown-kid" };
}

// Verify an ES256 launch token against the Rooms JWKS. Algorithm is pinned to
// ES256 — we never read the token header's own alg.
export async function verifyLaunchAsym(token: string | null | undefined): Promise<AsymResult> {
  const issuer = process.env.ROOMS_ISSUER;
  const jwksUrl = process.env.ROOMS_JWKS_URL;
  const audience = process.env.ROOMS_ROOM_ID;
  if (!issuer || !jwksUrl || !audience) return { claims: null, reason: "no-config" };
  if (!token) return { claims: null, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { claims: null, reason: "malformed" };
  const [h, p, sig] = parts;

  let kid: string | undefined;
  try {
    kid = (JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid?: string }).kid;
  } catch {
    return { claims: null, reason: "malformed" };
  }
  if (!kid) return { claims: null, reason: "malformed" };

  const { key, reason } = await keyFor(kid, jwksUrl);
  if (!key) return { claims: null, reason };

  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlToBytes(sig); // raw R||S, 64 bytes
  } catch {
    return { claims: null, reason: "malformed" };
  }

  const data = new TextEncoder().encode(`${h}.${p}`);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sigBytes, data);
  if (!valid) return { claims: null, reason: "bad-signature" };

  let claims: LaunchClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as LaunchClaims;
  } catch {
    return { claims: null, reason: "malformed" };
  }

  if (claims.iss !== issuer) return { claims: null, reason: "wrong-iss" };
  if (claims.aud !== audience) return { claims: null, reason: "wrong-aud" };
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp + EXP_SKEW_S) {
    return { claims: null, reason: "expired" };
  }
  if (typeof claims.playerId !== "string" || typeof claims.displayName !== "string") {
    return { claims: null, reason: "missing-claims" };
  }

  return {
    claims: {
      playerId: claims.playerId,
      displayName: claims.displayName,
      avatarToken: claims.avatarToken ?? "",
      returnUrl: claims.returnUrl ?? "",
      roomId: claims.roomId ?? audience,
      iat: claims.iat ?? 0,
      exp: claims.exp,
    },
  };
}
