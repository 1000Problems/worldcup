// ---------------------------------------------------------------------------
// Chat identity — SERVER ONLY.
//
// Posting to chat must be attributed to a real, verified player. We reuse the
// exact Rooms token verification from roomsAuth.ts rather than inventing a
// second signing scheme: middleware stashes the already-signed launch JWT in an
// HttpOnly cookie, and here we re-verify it on every chat request.
//
// The cookie carries the JWT verbatim, so it inherits the token's own expiry
// and HS256 signature — no new secret, no new trust assumptions.
// ---------------------------------------------------------------------------

import { cookies } from "next/headers";
import { verifyRoomsSession, type RoomsPlayer } from "@/lib/roomsAuth";

export const SESSION_COOKIE = "rooms_session";

// Verified player from the session cookie, or null (missing / bad / expired).
export function getChatSession(): RoomsPlayer | null {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return verifyRoomsSession(token);
}
