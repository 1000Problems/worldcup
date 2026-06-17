import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, optionsFor } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /event/{ref} — the roster/options plus advisory dates and labels.
export async function GET(_req: NextRequest, { params }: { params: { ref: string } }) {
  const m = getMatch(params.ref);
  if (!m) return json({ error: "unknown event ref" }, 404);

  return json({
    ref: m.ref,
    options: optionsFor(m).map((o) => ({ id: o.id, label: o.label, points: o.points })),
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
