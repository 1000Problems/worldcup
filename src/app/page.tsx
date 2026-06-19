import { cookies } from "next/headers";
import RoomClient from "./RoomClient";
import { verifyRoomsSession } from "@/lib/roomsAuth";
import { isAsymConfigured, verifyLaunchAsym } from "@/lib/launchVerifyAsym";
import { SESSION_COOKIE } from "@/lib/chatSession";
import { listSeries, getMatch, phaseFor, getResult } from "@/lib/rooms";

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
  const ref = one(searchParams.ref);

  // No match chosen → show OUR launch landing so the player picks the event.
  // Guiding to the right event is the room's job; Rooms launches us blind. The
  // cookie session (minted from the launch token by middleware) keeps the player
  // signed in across these same-origin `?ref=` links.
  if (!ref) {
    return <Landing returnUrl={player?.returnUrl ?? null} />;
  }

  return (
    <RoomClient
      matchRef={ref}
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

// --- Launch landing --------------------------------------------------------
// Server-rendered list of the series' matches. Each card deep-links to
// `?ref=<eventRef>`, which renders RoomClient for that match. This is the
// navigation Rooms used to host — it now lives entirely here.
function fmtKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  }) + " ET";
}

async function Landing({ returnUrl }: { returnUrl: string | null }) {
  // Pilot: one deployment, one series. List its events.
  const series = listSeries()[0] ?? null;
  const events = [];
  if (series) {
    for (const ref of series.eventRefs) {
      const m = getMatch(ref);
      if (!m) continue;
      const phase = await phaseFor(m);
      const result = phase === "closed" ? await getResult(ref) : null;
      events.push({ m, phase, result });
    }
  }

  return (
    <main className="wrap">
      <p className="kicker">{series?.display.name ?? "World Cup Match Predictor"}</p>
      <h1 style={{ textAlign: "center", fontSize: 26, margin: "8px 0 2px" }}>Pick a match</h1>
      <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 14, margin: "0 0 22px" }}>
        {series?.display.blurb ?? "Call the result before kickoff."}
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {events.length === 0 && (
          <p style={{ textAlign: "center", color: "var(--muted)" }}>No matches available yet.</p>
        )}
        {events.map(({ m, phase, result }) => {
          const status =
            phase === "closed"
              ? `Final · ${m.home.code} ${result?.homeGoals ?? 0}–${result?.awayGoals ?? 0} ${m.away.code}`
              : phase === "locked"
                ? "In play · picks locked"
                : `Locks at kickoff · ${fmtKickoff(m.kickoffISO)}`;
          const accent =
            phase === "closed" ? "var(--draw)" : phase === "locked" ? "var(--saudi)" : "var(--accent)";
          return (
            <a
              key={m.ref}
              href={`?ref=${encodeURIComponent(m.ref)}`}
              style={{
                display: "block", textDecoration: "none", color: "inherit",
                border: "1px solid var(--line)", borderRadius: 14, padding: "16px 18px",
                background: "var(--bg-1)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: 17, fontWeight: 700 }}>{m.home.name} vs {m.away.name}</span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{m.stage}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: accent, marginTop: 6 }}>{status}</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 6 }}>{m.venue}</div>
            </a>
          );
        })}
      </div>

      {returnUrl && (
        <p style={{ textAlign: "center", marginTop: 24 }}>
          <a href={returnUrl} style={{ color: "var(--muted)", fontSize: 13 }}>← Return to Rooms</a>
        </p>
      )}
    </main>
  );
}
