import { NextResponse, type NextRequest } from "next/server";

// When Rooms launches the room at `/?t=<token>`, stash the launch JWT in an
// HttpOnly cookie so server-side chat requests can attribute posts to a verified
// player. We do NOT verify here (Edge runtime lacks node:crypto) — the chat
// route handlers re-verify with roomsAuth on the Node runtime. The cookie just
// carries the already-signed token; it inherits the token's own expiry.
//
// We don't redirect-strip `?t=` here: page.tsx still reads it on first render to
// show verified identity, and RoomClient strips it from the address bar client-
// side. SameSite=None+Secure is required because we run inside the Rooms iframe
// (a third-party context), where a same-origin fetch is still cross-site.
export function middleware(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t");
  const res = NextResponse.next();
  if (token) {
    res.cookies.set("rooms_session", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 60 * 60 * 6, // 6h; the token's own exp is the real authority
    });
  }
  return res;
}

export const config = { matcher: ["/"] };
