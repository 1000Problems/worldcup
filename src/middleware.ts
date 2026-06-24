import { NextResponse, type NextRequest } from "next/server";
import { verifyLaunch, mintSession } from "@/lib/roomSession";

// When Rooms launches the room at `/?t=<token>`, exchange the short, single-use
// launch ticket (exp ~5 min) for a longer-lived room session stored in an
// HttpOnly cookie. Without this, a player who lingers past the ticket's TTL while
// composing a prediction would start getting 401s on /pick and /chat.
//
// The launch token is verified here (Edge runtime → Web Crypto, not node:crypto):
// HS256 with our ROOMS_SIGNING_KEY. The host (PickCity) is HS256-symmetric by
// design — no JWKS / ES256 — so this is the only path. We then mint our OWN HS256
// room session, which downstream Node routes verify with roomsAuth, unchanged.
//
// We don't redirect-strip `?t=` here: page.tsx reads it on first render and
// RoomClient strips it from the address bar client-side. SameSite=None+Secure is
// required because we run inside the Rooms iframe (a third-party context).
export async function middleware(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t");
  const res = NextResponse.next();
  const key = process.env.ROOMS_SIGNING_KEY;

  if (token && key) {
    const claims = await verifyLaunch(token, key); // HS256
    if (claims) {
      const { token: session, maxAge } = await mintSession(claims, key);
      res.cookies.set("rooms_session", session, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        maxAge,
      });
    }
    // An invalid/forged `?t=` mints nothing — we never re-sign unverified claims.
  }
  return res;
}

export const config = { matcher: ["/"] };
