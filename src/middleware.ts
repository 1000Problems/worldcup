import { NextResponse, type NextRequest } from "next/server";
import { verifyLaunch, mintSession } from "@/lib/roomSession";

// When Rooms launches the room at `/?t=<token>`, exchange the short, single-use
// launch ticket (exp ~5 min) for a longer-lived room session stored in an
// HttpOnly cookie. Without this, a player who lingers past the ticket's TTL while
// composing a prediction would start getting 401s on /pick and /chat — the cookie
// would outlive the token it carried. We verify the launch token here (Edge
// runtime → Web Crypto, not node:crypto), then re-issue the same identity with a
// 6h exp; downstream Node routes verify that session with roomsAuth, unchanged.
//
// We don't redirect-strip `?t=` here: page.tsx reads it on first render and
// RoomClient strips it from the address bar client-side. SameSite=None+Secure is
// required because we run inside the Rooms iframe (a third-party context).
export async function middleware(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t");
  const res = NextResponse.next();
  const key = process.env.ROOMS_SIGNING_KEY;

  if (token && key) {
    const claims = await verifyLaunch(token, key);
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
