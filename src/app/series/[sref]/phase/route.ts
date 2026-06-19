import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { seriesPhase } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /series/{sref}/phase — upcoming | open | live | completed, derived from the
// member events but exposed as the game's own signal (the game is the authority
// on whether the bracket is exhausted). Mirrors /phase/{ref}'s shape.
export async function GET(_req: NextRequest, { params }: { params: { sref: string } }) {
  const phase = await seriesPhase(params.sref);
  if (!phase) return json({ error: "unknown series ref" }, 404);

  return json({ phase, status: "scheduled" });
}

export function OPTIONS() {
  return preflight();
}
