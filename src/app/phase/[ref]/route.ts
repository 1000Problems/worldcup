import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, phaseFor } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /phase/{ref} — open | locked | closed. We are the authority on lock:
// it fires at kickoff, and we go closed once a result is posted.
export async function GET(_req: NextRequest, { params }: { params: { ref: string } }) {
  const m = getMatch(params.ref);
  if (!m) return json({ error: "unknown event ref" }, 404);

  return json({ phase: phaseFor(m), status: "scheduled" });
}

export function OPTIONS() {
  return preflight();
}
