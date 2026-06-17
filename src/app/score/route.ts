import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { scorePicks, type Pick, type ResultDef } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// POST /score { result, picks[] } → ScoreBreakdown[]. PURE: no IO, no clock, no
// randomness. Rooms re-runs this to audit the board, so the same (result, picks)
// must always yield the same points.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.result || !Array.isArray(body.picks)) {
    return json({ error: "expected { result, picks[] }" }, 400);
  }

  const result = body.result as ResultDef;
  const picks = body.picks as Pick[];
  return json(scorePicks(result, picks));
}

export function OPTIONS() {
  return preflight();
}
