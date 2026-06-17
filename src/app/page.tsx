import RoomClient from "./RoomClient";
import { verifyRoomsSession } from "@/lib/roomsAuth";

// Read per request so the launch token in `?t=` is verified server-side.
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : null;
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  const token = one(searchParams.t);
  const player = verifyRoomsSession(token); // null if missing / bad / expired

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
