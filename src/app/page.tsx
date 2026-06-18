import { cookies } from "next/headers";
import RoomClient from "./RoomClient";
import { verifyRoomsSession } from "@/lib/roomsAuth";
import { isAsymConfigured, verifyLaunchAsym } from "@/lib/launchVerifyAsym";
import { SESSION_COOKIE } from "@/lib/chatSession";

// Read per request so the launch token in `?t=` is verified server-side.
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

type SafePlayer = { playerId: string; displayName: string; avatarToken: string; returnUrl: string } | null;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : null;
}

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  // Two distinct credentials:
  //   - `?t=` is the LAUNCH token from Rooms — ES256/JWKS when configured (target),
  //     HS256 shared key otherwise (interim). Present only on the launch request.
  //   - the cookie is OUR room session (always HS256, minted by middleware), which
  //     keeps the player verified after the short launch ticket expires.
  const t = one(searchParams.t);
  const cookieTok = cookies().get(SESSION_COOKIE)?.value ?? null;

  let player: SafePlayer = null;
  if (t) {
    player = isAsymConfigured() ? (await verifyLaunchAsym(t)).claims : verifyRoomsSession(t);
  } else {
    player = verifyRoomsSession(cookieTok); // room session
  }

  const token = t ?? cookieTok;

  return (
    <RoomClient
      matchRef={one(searchParams.ref) ?? "match-38"}
      player={
        player
          ? {
              playerId: player.playerId,
              displayName: player.displayName,
              avatarToken: player.avatarToken,
            }
          : null
      }
      returnUrl={player?.returnUrl ?? null}
      // Dev-only, untrusted: lets us test the UI without a real token.
      devName={one(searchParams.name)}
      // Masked hint only — never the token itself — for the debug panel.
      tokenHint={token ? `present (…${token.slice(-6)})` : "absent"}
    />
  );
}
