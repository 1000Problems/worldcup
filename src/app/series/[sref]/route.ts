import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getSeries, getMatch, phaseFor, getResult, seriesPhase } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /series/{sref} — the hub's data source, the single call the host makes to
// render the tournament hub. Labels come from getMatch; per-event `phase` is the
// same value /phase/{ref} returns (one source of truth, not a parallel field).
// Everything here is data the game owns; the host overlays identity, picks,
// scores, and standing. Never carries picks.
export async function GET(_req: NextRequest, { params }: { params: { sref: string } }) {
  const s = getSeries(params.sref);
  if (!s) return json({ error: "unknown series ref" }, 404);

  const events = [];
  for (const ref of s.eventRefs) {
    const m = getMatch(ref);
    if (!m) continue;
    const phase = await phaseFor(m);
    const event: {
      ref: string;
      label: string;
      stage: string;
      expectedLockAt: string;
      phase: typeof phase;
      status: string;
      result?: { score: string; outcome: string };
    } = {
      ref: m.ref,
      label: `${m.home.name} vs ${m.away.name}`,
      stage: m.stage,
      expectedLockAt: m.kickoffISO,
      phase,
      status: "scheduled",
    };
    // `result` is present only when that event's phase is closed.
    if (phase === "closed") {
      const r = await getResult(m.ref);
      if (r) event.result = { score: `${r.homeGoals}-${r.awayGoals}`, outcome: r.outcome };
    }
    events.push(event);
  }

  return json({
    ref: s.ref,
    display: s.display,
    phase: await seriesPhase(s.ref),
    events,
    standingSpec: { aggregation: s.aggregation, trophyLabel: s.trophyLabel },
  });
}

export function OPTIONS() {
  return preflight();
}
