import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, MAX_GOALS, MAX_MINUTE } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /event/{ref} — the labels, the structured pick schema, advisory dates.
export async function GET(_req: NextRequest, { params }: { params: { ref: string } }) {
  const m = getMatch(params.ref);
  if (!m) return json({ error: "unknown event ref" }, 404);

  return json({
    ref: m.ref,
    // Players predict a scoreline plus the minute of every goal.
    pick: {
      kind: "scoreline-timed",
      fields: {
        homeGoals: { min: 0, max: MAX_GOALS },
        awayGoals: { min: 0, max: MAX_GOALS },
        homeGoalMinutes: { count: "homeGoals", min: 1, max: MAX_MINUTE },
        awayGoalMinutes: { count: "awayGoals", min: 1, max: MAX_MINUTE },
      },
    },
    scoring: {
      summary: "Closest prediction wins: right outcome first, then closest scoreline, then closest goal minutes.",
      tiers: ["outcome", "score", "timing"],
    },
    expectedLockAt: m.kickoffISO,
    expectedResolveAt: m.kickoffISO, // result known shortly after full time
    labels: {
      title: `${m.home.name} vs ${m.away.name}`,
      competition: m.competition,
      stage: m.stage,
      venue: m.venue,
      home: m.home,
      away: m.away,
    },
  });
}

export function OPTIONS() {
  return preflight();
}
