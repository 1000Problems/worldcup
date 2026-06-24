import { cookies } from "next/headers";
import RoomClient from "./RoomClient";
import { verifyRoomsSession } from "@/lib/roomsAuth";
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
  //   - `?t=` is the LAUNCH token from Rooms/PickCity — HS256, signed with our
  //     ROOMS_SIGNING_KEY. Present only on the launch request. The host is HS256-
  //     symmetric by design (no JWKS / ES256), so we verify it directly.
  //   - the cookie is OUR room session (also HS256, minted by middleware), which
  //     keeps the player verified after the short launch ticket expires.
  const t = one(searchParams.t);
  const cookieTok = cookies().get(SESSION_COOKIE)?.value ?? null;

  const player: SafePlayer = verifyRoomsSession(t ?? cookieTok);

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
// Server-rendered list of the series' matches in the Goal Rush design language
// (the same one RoomClient uses): light theme, Oswald display type, white
// fixture cards, the red wordmark. Each card deep-links to `?ref=<eventRef>`,
// which renders RoomClient for that match. This is the navigation Rooms used to
// host — it now lives entirely here.

// Palette shared with RoomClient.tsx — keep in sync.
const GR = {
  red: "#E20613",
  ink: "#15161A",
  mut: "#6B6E76",
  green: "#009E60",
  faint: "#9b9ea6",
  line: "rgba(21,22,26,.08)",
  redTint: "#FCEAEB",
  greenTint: "#E6F6EF",
  panel: "#F4F5F7",
  osw: "'Oswald',sans-serif",
};

function fmtKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  }) + " ET";
}

// Per-phase chrome for a match card: corner pill + status line colour.
function phaseChrome(phase: string) {
  if (phase === "closed") return { pill: "Full time", pillBg: GR.panel, pillCol: GR.mut, accent: GR.green };
  if (phase === "locked") return { pill: "Live", pillBg: GR.redTint, pillCol: GR.red, accent: GR.red };
  return { pill: "Open", pillBg: GR.greenTint, pillCol: "#008A54", accent: GR.ink };
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

  const played = events.filter((e) => e.phase === "closed").length;
  const openNow = events.filter((e) => e.phase === "open").length;
  const live = events.filter((e) => e.phase === "locked").length;

  return (
    <div style={{ minHeight: "100vh", paddingBottom: 44 }}>
      <div style={{ height: 5, background: GR.red }} />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 18px 0" }}>
        {/* HEADER — the same wordmark the room carries */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: GR.red, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 23, boxShadow: "0 4px 12px rgba(226,6,19,.32)" }}>⚽</div>
          <div>
            <div style={{ fontFamily: GR.osw, fontWeight: 700, fontSize: 24, letterSpacing: ".01em", lineHeight: 0.95, textTransform: "uppercase" }}>
              GOAL<span style={{ color: GR.red }}>RUSH</span>
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: GR.mut, letterSpacing: ".02em", marginTop: 1 }}>Predict · banter · win the room</div>
          </div>
        </div>

        {/* SERIES HERO */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 11 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: GR.red }} />
            <span style={{ fontFamily: GR.osw, fontWeight: 600, fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: GR.red }}>
              {series?.competition ?? "FIFA World Cup 2026"}
            </span>
          </div>
          <h1 style={{ fontFamily: GR.osw, fontWeight: 700, fontSize: 30, lineHeight: 1.05, letterSpacing: ".01em", textTransform: "uppercase", margin: "0 0 9px" }}>
            {series?.display.name ?? "Pick a match"}
          </h1>
          <p style={{ fontSize: 14.5, color: GR.mut, fontWeight: 500, lineHeight: 1.5, margin: 0, maxWidth: 540 }}>
            {series?.display.blurb ?? "Call the result before kickoff."}
          </p>
          {events.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
              {[
                [`${played} of ${events.length} played`, GR.panel, GR.mut],
                live > 0 ? [`${live} live now`, GR.redTint, GR.red] : null,
                openNow > 0 ? [`${openNow} open`, GR.greenTint, "#008A54"] : null,
              ]
                .filter(Boolean)
                .map((t, i) => {
                  const [label, bg, col] = t as [string, string, string];
                  return (
                    <span key={i} style={{ fontFamily: GR.osw, fontWeight: 600, fontSize: 11.5, letterSpacing: ".04em", textTransform: "uppercase", background: bg, color: col, borderRadius: 30, padding: "5px 13px" }}>
                      {label}
                    </span>
                  );
                })}
            </div>
          )}
        </div>

        {/* MATCH CARDS */}
        <div style={{ display: "grid", gap: 14 }}>
          {events.length === 0 && (
            <p style={{ textAlign: "center", color: GR.mut, fontWeight: 600, padding: "32px 0" }}>No matches available yet.</p>
          )}
          {events.map(({ m, phase, result }) => {
            const c = phaseChrome(phase);
            const status =
              phase === "closed"
                ? `Final · ${m.home.code} ${result?.homeGoals ?? 0}–${result?.awayGoals ?? 0} ${m.away.code}`
                : phase === "locked"
                  ? "Picks locked · match under way"
                  : `Locks at kickoff · ${fmtKickoff(m.kickoffISO)}`;
            return (
              <a
                key={m.ref}
                className="gr-card"
                href={`?ref=${encodeURIComponent(m.ref)}`}
                style={{
                  display: "block", textDecoration: "none", color: "inherit",
                  background: "#fff", border: `1px solid ${GR.line}`, borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(21,22,26,.04),0 14px 34px rgba(21,22,26,.07)",
                  overflow: "hidden",
                }}
              >
                <div style={{ padding: "16px 20px 18px" }}>
                  {/* competition · stage + phase pill */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: GR.red, flexShrink: 0 }} />
                      <span style={{ fontFamily: GR.osw, fontWeight: 600, fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: GR.red, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.stage}
                      </span>
                    </div>
                    <span style={{ flexShrink: 0, fontFamily: GR.osw, fontWeight: 600, fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase", background: c.pillBg, color: c.pillCol, borderRadius: 30, padding: "4px 11px" }}>
                      {c.pill}
                    </span>
                  </div>

                  {/* fixture */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11, flex: 1, minWidth: 0 }}>
                      <LandingCrest code={m.home.code} color={GR.red} />
                      <span style={{ fontFamily: GR.osw, fontWeight: 600, fontSize: 18, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.home.name}</span>
                    </div>
                    <div style={{ flexShrink: 0, fontFamily: GR.osw, fontWeight: 700, fontSize: phase === "closed" ? 20 : 13, color: phase === "closed" ? GR.ink : GR.faint, letterSpacing: ".06em" }}>
                      {phase === "closed" && result ? `${result.homeGoals}–${result.awayGoals}` : "VS"}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 11, flex: 1, minWidth: 0, justifyContent: "flex-end", textAlign: "right" }}>
                      <span style={{ fontFamily: GR.osw, fontWeight: 600, fontSize: 18, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.away.name}</span>
                      <LandingCrest code={m.away.code} color={GR.green} />
                    </div>
                  </div>
                </div>

                {/* status footer */}
                <div style={{ borderTop: `1px solid ${GR.line}`, background: "rgba(21,22,26,.015)", padding: "11px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: c.accent }}>{status}</span>
                  <span style={{ fontSize: 12.5, color: GR.faint, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{m.venue}</span>
                </div>
              </a>
            );
          })}
        </div>

        {returnUrl && (
          <p style={{ textAlign: "center", marginTop: 26 }}>
            <a href={returnUrl} style={{ fontSize: 13, fontWeight: 600, color: GR.mut, textDecoration: "none", background: "#fff", border: `1px solid ${GR.line}`, borderRadius: 11, padding: "8px 14px", display: "inline-block" }}>
              ← Return to Rooms
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function LandingCrest({ code, color }: { code: string; color: string }) {
  return (
    <div style={{ width: 46, height: 46, borderRadius: 11, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#fff", fontFamily: GR.osw, letterSpacing: ".02em", flexShrink: 0 }}>
      {code}
    </div>
  );
}
