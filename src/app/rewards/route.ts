import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import type { ResultDef } from "@/lib/rooms";

export const dynamic = "force-dynamic";

interface Standing {
  playerId: string;
  points: number;
}

// POST /rewards { result, standings } → RewardProposal. Advisory only — Rooms
// validates, caps, and mints. We propose a trophy, a renown bonus, and a
// "called-it" badge for everyone who got the result right.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = body?.result as ResultDef | undefined;
  const standings = (body?.standings as Standing[] | undefined) ?? [];

  const winners = standings.filter((s) => s.points > 0);

  return json({
    trophy: { publicLabel: "Oracle of Atlanta", iconToken: "soccer" },
    renownProposal: {
      bonus: 10,
      reason: result ? `Called the ${result.homeGoals}-${result.awayGoals} result` : "Correct call",
    },
    badges: winners.map((s) => ({ playerId: s.playerId, code: "called-it" })),
  });
}

export function OPTIONS() {
  return preflight();
}
