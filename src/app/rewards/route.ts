import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import type { ResultDef } from "@/lib/rooms";

export const dynamic = "force-dynamic";

interface Standing {
  playerId: string;
  points: number;
}

// Correct outcome contributes the dominant band (>= 1,000,000), so any positive
// points up there means the player called the result right.
const CORRECT_OUTCOME_FLOOR = 1_000_000;

// POST /rewards { result, standings } → RewardProposal. Advisory only — Rooms
// validates, caps, and mints. Trophy goes to everyone tied at the top score
// (shared win); a "called-it" badge to every correct-outcome player.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = body?.result as ResultDef | undefined;
  const standings = (body?.standings as Standing[] | undefined) ?? [];

  const top = standings.reduce((max, s) => Math.max(max, s.points), 0);
  const winners = top > 0 ? standings.filter((s) => s.points === top) : [];
  const calledIt = standings.filter((s) => s.points >= CORRECT_OUTCOME_FLOOR);

  return json({
    trophy: { publicLabel: "Oracle of Atlanta", iconToken: "soccer" },
    renownProposal: {
      bonus: 10,
      reason: result ? `Closest call on the ${result.homeGoals}-${result.awayGoals} result` : "Closest call",
    },
    // Advisory: Rooms decides how the shared trophy is granted across ties.
    winners: winners.map((s) => s.playerId),
    badges: calledIt.map((s) => ({ playerId: s.playerId, code: "called-it" })),
  });
}

export function OPTIONS() {
  return preflight();
}
