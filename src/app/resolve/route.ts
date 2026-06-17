import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, getResult } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// POST /resolve { ref } — the normalized real-world result, or null if not yet
// known. Resolution is world-fed (a real match), entered via /admin/resolve.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ref: string | undefined = body?.ref;
  const m = ref ? getMatch(ref) : null;
  if (!m) return json({ error: "unknown event ref" }, 404);

  return json(getResult(m.ref)); // ResultDef | null
}

export function OPTIONS() {
  return preflight();
}
