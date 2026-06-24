import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET /contract — the manifest. The Rooms host introspects this to learn who we
// are and how to render and reward the game. Keep it returning valid JSON at all
// times; it's the handshake everything else hangs off.
export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  return json({
    id: "wc-match-predictor",
    contractVersion: "1.0",
    display: {
      name: "World Cup Match Predictor",
      blurb: "Call the result before kickoff.",
      iconToken: "soccer",
    },
    // canonical: one real-world match is shared by many rooms (the F1 model).
    // The specific match is selected by the event ref.
    roomShape: { instancing: "canonical", minPlayers: 1, maxPlayers: 100000 },
    // Composite pick: a scoreline plus the minute of every goal. Not a tier-1
    // primitive, so the renderer is bespoke and Rooms stores the pick opaquely.
    pickSchema: {
      kind: "scoreline-timed",
      fields: ["homeGoals", "awayGoals", "homeGoalMinutes", "awayGoalMinutes"],
    },
    capabilities: {
      renderer: "bespoke",
      rendererUrl: `${origin}/`,
      liveState: false,
      resolution: "world-fed",
      rewards: ["trophy"],
    },
    // This game also exposes a series the host can enumerate (GET /series). The
    // host sums per-event boards (pushed at /close) into the aggregate standing.
    series: { ref: "world-cup-2026", aggregation: "sum" },
    // Private games: any unknown roomId that launches in becomes an isolated room
    // over this same schedule. This flag is the ENTIRE handshake — it's what makes
    // PickCity render the "Create private game" button (GAME-INTEGRATION-PRIVATE.md).
    allowsPrivate: true,
    badgeCatalog: [{ code: "called-it", label: "Called It" }],
  });
}

export function OPTIONS() {
  return preflight();
}
