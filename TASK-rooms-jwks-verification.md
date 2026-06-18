# TASK: Verify launch tokens via Rooms JWKS (ES256), with a room-id allowlist

> Replace the HS256 shared-secret launch-token verifier with stateless ES256/JWKS
> verification, and gate it on an allowlist of our own room ids so a token minted for
> another third-party room can't pass our verification.

## ⛔ Blocked on Rooms — do not start until these land

Code must not guess these. They come from the Rooms team (see
`ROOMS-reply-confirm-jwks.md`). Wire everything behind env vars now; fill values at cutover.

- **`iss`** — final production issuer string.
- **JWKS URL** — production `.well-known/jwks.json`.
- **Our room-id allowlist** — the list of room ids registered to us, plus how it's
  fetched/refreshed. Until confirmed, the allowlist is supplied via env (comma-separated).
- **`aud` vs `roomId`** — Rooms' token carries both; confirm which is authoritative for
  identifying the room. This task gates on **`aud`**; revisit if Rooms says `roomId`.
- **`exp`/`iat` semantics + acceptable clock skew** — confirm before finalizing the skew.
- **A production-signed test token** — required to verify the live chain.

**Decided:** no new dependency — hand-roll ES256 + JWKS on `node:crypto` + global
`fetch`, keeping the repo zero-dep (consistent with the existing HS256 verifier and the
project's no-new-deps rule).

## Context

Rooms is moving player launch tokens off a per-registration HS256 shared secret onto
platform-level **ES256** signing with a published **JWKS** (full thread in
`ROOMS-reply-confirm-jwks.md` / Rooms' answer). Under a shared JWKS every third-party
room verifies against the **same** public key — so signature validity alone no longer
proves the token was minted for *our* room. We must additionally check `aud` against an
allowlist of our room ids, or a token for someone else's room would pass. Today
`src/lib/roomsAuth.ts` does HS256 with `ROOMS_SIGNING_KEY`; this task swaps the mechanism
and adds the allowlist gate. Identity claims (`playerId`, `displayName`) are unchanged.

## Requirements

1. **ES256/JWKS verify in `src/lib/roomsAuth.ts`.** Resolve the signing key by the
   token header `kid` from the JWKS at `ROOMS_JWKS_URL` (cached; on an unknown `kid`,
   refetch the JWKS **once** before rejecting). Pin accepted algorithms to **`["ES256"]`**
   and never read the token's own `alg` header (alg-confusion / `alg:none` defense).

2. **Claim checks, fail-closed.** Reject unless all hold: signature valid; `iss` ===
   `ROOMS_ISSUER`; `exp` valid within the agreed skew (≤60s until Rooms confirms);
   `aud` present and a member of the allowlist from `ROOMS_ROOM_IDS`. If the allowlist
   env is unset/empty, **reject everything** (do not fall open). If `aud` arrives as an
   array, reject until Rooms confirms single-string semantics.

3. **Config + server-only invariants.** Read `ROOMS_ISSUER`, `ROOMS_JWKS_URL`,
   `ROOMS_ROOM_IDS` server-side only; remove `ROOMS_SIGNING_KEY` from the launch path
   (leave it documented for the future host↔room API seam). No key material, JWKS, or raw
   token may reach the client — `page.tsx` still passes only the safe claims
   (`playerId`, `displayName`, `avatarToken`, `returnUrl`) to `RoomClient`.

4. **Preserve existing behavior + add a failure reason.** Keep the dev-stub fallback on
   missing/invalid token, the `?t=` strip on mount, `Referrer-Policy: no-referrer`, and
   the masked-token debug panel. Add a **non-sensitive** failure-reason category surfaced
   in the debug panel — one of `no-config` / `malformed` / `jwks-unreachable` /
   `unknown-kid` / `bad-signature` / `wrong-iss` / `wrong-aud` / `expired` /
   `missing-claims` — so production rejections are diagnosable without exposing the token
   or keys.

5. **Docs, zero-dep.** No new npm dependency — implement ES256 verification and JWKS
   handling with `node:crypto` + global `fetch`. Update `CLAUDE.md` (auth model +
   Environment variables table: drop `ROOMS_SIGNING_KEY` from the launch path, add
   `ROOMS_ISSUER`, `ROOMS_JWKS_URL`, `ROOMS_ROOM_IDS`).

## Implementation Notes

**Files** — modify: `src/lib/roomsAuth.ts` (verifier rewrite), `src/app/page.tsx` (pass a
failure-reason hint alongside the masked token), `src/app/RoomClient.tsx` (render the
reason in the existing probe), `CLAUDE.md`. **No `package.json` dependency change** —
verification stays zero-dep.

**Target signature** — keep the existing call site shape; widen the return so the page
can show a reason:

```ts
export type RoomsPlayer = {
  playerId: string; displayName: string; avatarToken: string;
  returnUrl: string; roomId: string; iat: number; exp: number;
};
export type VerifyResult =
  | { ok: true; player: RoomsPlayer }
  | { ok: false; reason:
      "no-config" | "malformed" | "jwks-unreachable" | "unknown-kid" | "bad-signature" |
      "wrong-iss" | "wrong-aud" | "expired" | "missing-claims" };

export async function verifyRoomsSession(token: string | null): Promise<VerifyResult>;
```

**JWKS cache** — module-level, persists across requests on a warm lambda; refetch once
on a cache miss, with a short cooldown so a bogus `kid` can't trigger a refetch storm:

```ts
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const b64urlToBuf = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string };
let cache: { keys: Map<string, Jwk>; at: number } | null = null;

async function getKey(kid: string): Promise<Jwk | null> {
  const fresh = cache && Date.now() - cache.at < 30_000; // cooldown
  if (!cache?.keys.has(kid) && !(fresh && cache?.keys.size)) {
    const res = await fetch(process.env.ROOMS_JWKS_URL!, { cache: "no-store" });
    if (!res.ok) throw new Error("jwks-unreachable");
    const { keys } = (await res.json()) as { keys: Jwk[] };
    cache = { keys: new Map(keys.map((k) => [k.kid, k])), at: Date.now() };
  }
  return cache?.keys.get(kid) ?? null; // still missing → caller returns unknown-kid
}
```

**ES256 verify** — the JWS signature is raw `R||S` (64 bytes), **not** DER, so
`node:crypto` must be told `dsaEncoding: "ieee-p1363"` or verification silently always
fails:

```ts
const [h, p, s] = token.split(".");                       // 3 parts or → "malformed"
const kid = JSON.parse(b64urlToBuf(h).toString("utf8")).kid as string;
const jwk = await getKey(kid);                             // → "unknown-kid" if null
const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
const ok = cryptoVerify(
  "sha256",
  Buffer.from(`${h}.${p}`),
  { key: pub, dsaEncoding: "ieee-p1363" },                 // raw R||S, not DER
  b64urlToBuf(s),
);                                                        // false → "bad-signature"
```

Then decode the payload and check, in order: `iss === ROOMS_ISSUER` (`wrong-iss`),
`exp` within skew (`expired`), `aud` is a string in the `ROOMS_ROOM_IDS` allowlist —
fail closed if the allowlist is empty (`wrong-aud`), required claims present
(`missing-claims`). Never read the header's `alg`; we always do ES256.
`verifyRoomsSession` is async — `page.tsx` is already a server component, so `await` it.

**Scope guard** — this task is identity/verification only. Do **not** build aud-based
match routing here (that's the separate host→ref work in `ARCHITECTURE.md`); only enforce
the allowlist gate. The `ref` still resolves as it does today.

## Do Not Change

- `src/lib/rooms.ts` scoring and the `/score` purity guarantee — identity only here.
- Route handlers `/score`, `/validate`, `/event`, `/phase`, `/resolve`, `/rewards`,
  `/admin/*` — not identity-gated, unchanged.
- `Access-Control-Allow-Origin: *` and the **absent** `X-Frame-Options` in
  `next.config.js` — iframe embedding must keep working; only auth-related config moves.
- `rendererUrl` origin derivation in `/contract`.
- Host→ref routing — out of scope; do not implement aud-based match selection.

## Acceptance Criteria

- [ ] `npm run build` passes with zero type/lint errors.
- [ ] `package.json` gains no new dependency — verification is `node:crypto` + `fetch` only.
- [ ] `grep -rn "ROOMS_ISSUER\|ROOMS_JWKS_URL\|ROOMS_ROOM_IDS\|ROOMS_SIGNING_KEY" src`
      shows these only in server code; none appear in any `"use client"` file or the
      `.next` client bundle.
- [ ] A production-signed test token with an `aud` in `ROOMS_ROOM_IDS` verifies and the
      UI greets its `displayName`.
- [ ] **Cross-room bypass blocked:** a validly-signed token whose `aud` is NOT in the
      allowlist is rejected (`reason: "wrong-aud"`).
- [ ] A token with a tampered signature → `bad-signature`; a non-ES256 / `alg:none`
      forgery → rejected (not accepted under any other alg).
- [ ] An expired token (beyond skew) → `expired`; a wrong `iss` → `wrong-iss`.
- [ ] Unknown `kid` triggers exactly one JWKS refetch, then verifies or rejects.
- [ ] With `ROOMS_ROOM_IDS` unset/empty, every token is rejected (fail-closed).
- [ ] After load the address bar has no `?t=`, responses carry `Referrer-Policy:
      no-referrer`, and the debug panel shows only the masked token plus the reason.
- [ ] `git diff` shows changes only in the files listed under Implementation Notes.

## Verification

1. `npm run build`; then `next start` with test `ROOMS_ISSUER` / `ROOMS_JWKS_URL` /
   `ROOMS_ROOM_IDS` pointing at the Rooms-provided test JWKS.
2. Open `/?t=<prod-test-token>` — confirm greeting, stripped URL, Return link.
3. Re-sign or hand-craft tokens to exercise each rejection path: wrong `aud`, wrong
   `iss`, expired, tampered signature, `alg:none`, unknown `kid`.
4. Confirm the JWKS is fetched at most once per unknown `kid` (check it's cached, not
   refetched per request).
5. `grep` the env-var names across `src` and inspect `.next` to confirm no secret/JWKS
   material lands in client output.
6. `git diff` — no files outside scope touched.
