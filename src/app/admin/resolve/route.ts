import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, setResult } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// POST /admin/resolve { ref, homeGoals, awayGoals }
// Manual result entry. Gated by the ADMIN_TOKEN env var (sent as a Bearer token).
// This is the seam where a football-data feed would later write automatically.
export async function POST(req: NextRequest) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return json({ error: "ADMIN_TOKEN not configured" }, 500);

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const ref: string | undefined = body?.ref;
  const m = ref ? getMatch(ref) : null;
  if (!m) return json({ error: "unknown event ref" }, 404);

  const { homeGoals, awayGoals } = body;
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
    return json({ error: "homeGoals and awayGoals must be non-negative integers" }, 400);
  }

  return json(setResult(m.ref, homeGoals, awayGoals));
}

export function OPTIONS() {
  return preflight();
}
