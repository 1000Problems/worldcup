# TASK: Speak the Rooms v1 contract with one stable key

> Wire all three Rooms flows — launch verify, signed `/state`, signed `/close` push — to the single stable `ROOMS_SIGNING_KEY`, so a Rooms user can enter, Rooms can read state, and Rooms gets the resolution.

## Context

We confirmed the v1 auth model with Rooms: **one stable, symmetric per-room key** (copied from the Rooms `/developer` page into `ROOMS_SIGNING_KEY`) is the trust anchor for everything. Rooms signs the launch token with it, signs its `/state` poll with it, and verifies our `/close` callback with it.

Today we only do the first flow: `src/lib/roomsAuth.ts` verifies `?t=`. But Rooms polls `GET /state?roomId=&playerId=` (we expose `/phase/[ref]` instead) and receives results via `POST {rooms}/api/rooms/close` (we never push). This task adds the two missing endpoints and the result push, all keyed on the one stable secret. The host wire format is fixed by `Rooms/ROOMS-INTEGRATION.md` and `Rooms/lib/roomState.ts`.

This is v1: **single match, single room, single deployment** — the multi-match design is cancelled. One `ROOMS_SIGNING_KEY`, one `roomId`.

## Requirements

1. **Launch verify — confirm wired.** `src/app/page.tsx` (server) must call `verifyRoomsSession` (`src/lib/roomsAuth.ts`) on `?t=`, pass only safe claims to `RoomClient.tsx`, and **save the `roomId` and `playerId`** from the token for use by `/state` and `/close`. `ROOMS_SIGNING_KEY` in Vercel = the key shown on Rooms `/developer`.
2. **Add `GET /state`.** New route `src/app/state/route.ts` answering `?roomId=&playerId=` with exactly `{ "phase": "open" | "locked" | "closed" }`. Derive the phase from the existing logic behind `/phase/[ref]` (`src/lib/rooms.ts`). Must respond in well under 1.5s (Rooms times out there).
3. **Verify the `/state` signature.** Read `X-Rooms-Timestamp` and `X-Rooms-Signature`; recompute `HMAC_SHA256(ROOMS_SIGNING_KEY, "<timestamp>:<roomId>:<playerId>")` as hex; compare in constant time. Reject (401, fast) if the header is missing/invalid **or** the timestamp is older than 300s (replay window). Fail closed when `ROOMS_SIGNING_KEY` is unset. Mirror the producer in `Rooms/lib/roomState.ts` lines 25-36.
4. **Push results on close.** When the match resolves to `closed`, `POST` once to `${ROOMS_HOST}/api/rooms/close` with raw body `{"roomId": "<saved roomId>", "results": [{"playerId","placement","rewards":{"trophy":{"label"},"xp","badges"}}]}` and header `X-Rooms-Signature: <hex HMAC_SHA256(ROOMS_SIGNING_KEY, rawBody)>`. Map each participant's pick + cascade score → `placement` and `rewards` (`xp` is capped 0–100 by Rooms). Idempotent — safe to retry; Rooms dedups.
5. **One stable key, server-only.** All three flows use `process.env.ROOMS_SIGNING_KEY` and nothing else; no per-player secret, never sent to the client. Keep the existing rich-contract endpoints (`/contract`, `/event`, `/phase`, `/resolve`, `/score`, `/rewards`) working — `/state` and the `/close` push are **additive** for the Rooms wire.

## Implementation Notes

- New env var `ROOMS_HOST` (e.g. `https://rooms.app` / the Rooms origin) for the `/close` target. Document it in `CLAUDE.md`'s env table alongside `ROOMS_SIGNING_KEY`.
- Signature helpers: `node:crypto` `createHmac` + `timingSafeEqual`, matching `roomsAuth.ts` style — zero new deps.
- `/state` may read the clock and phase; keep it separate from `/score`, which must stay pure.
- Result payload shape and field semantics are in `Rooms/ROOMS-INTEGRATION.md` §4 (the close body, `placement`, `rewards.xp` cap, `badges`).

## Do Not Change

- `src/lib/rooms.ts` cascade scorer and `src/app/score/route.ts` — `/score` must stay **pure** (no IO/clock/randomness; Rooms re-runs it to audit). Reuse its output for the `/close` mapping; do not add IO to it.
- `src/lib/roomsAuth.ts` verification logic — HS256 pinned, constant-time compare, exp skew are correct; do not weaken.
- Token hygiene already in place: `?t=` stripped on mount, token never reaches client JS/logs, `Referrer-Policy: no-referrer`.

## Dependency — resolve before building Requirement 4

Pushing `/close` requires worldcup to know **every participant's `playerId` + pick at resolution**. Our result store is in-memory and, under the rich contract, picks may be held by Rooms. Confirm with Angel where participant picks are persisted for the push (worldcup-owned store vs. read back from Rooms) before implementing Requirement 4. Requirements 1–3 are unblocked.

## Acceptance Criteria

- [ ] `npm run build` (`next build`) passes with zero type/lint errors.
- [ ] `GET /state` with a valid `X-Rooms-Signature` returns the correct phase; a missing, wrong, or stale (>300s) signature returns 401, quickly.
- [ ] A resolved match `POST`s `/close` exactly once; re-posting the same body does not double-grant (idempotent).
- [ ] A Rooms launch lands the player identified; an expired/invalid `?t=` falls back to the labelled dev stub and never crashes.
- [ ] `grep -r ROOMS_SIGNING_KEY src` shows it only in server modules; `.next` bundle inspection shows it is not in client JS.
- [ ] `git diff` shows changes only in: `src/app/page.tsx`, `src/app/state/route.ts` (new), the close-push module, and `CLAUDE.md`.

## Verification

1. `npm run build`.
2. `curl` `/state` with a correct hand-computed signature → phase; with a bad/old one → 401.
3. Drive the match to `closed` (admin console), confirm one signed `/close` POST and the trophy appearing in Rooms; re-fire and confirm no double-grant.
4. Confirm `/score` output is unchanged by diffing two identical calls (purity).
5. `git diff` — scope check.
