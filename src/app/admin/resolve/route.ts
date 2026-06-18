import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, setResult, MAX_GOALS, MAX_MINUTE } from "@/lib/rooms";
import { pushClose } from "@/lib/roomsClose";

export const dynamic = "force-dynamic";

// POST /admin/resolve { ref, homeGoals, awayGoals, homeGoalMinutes[], awayGoalMinutes[] }
// Manual result entry, gated by the ADMIN_TOKEN env var (Bearer token).
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

  const { homeGoals, awayGoals } = body ?? {};
  const homeGoalMinutes = body?.homeGoalMinutes ?? [];
  const awayGoalMinutes = body?.awayGoalMinutes ?? [];

  for (const [label, g] of [["homeGoals", homeGoals], ["awayGoals", awayGoals]] as const) {
    if (!Number.isInteger(g) || g < 0 || g > MAX_GOALS) {
      return json({ error: `${label} must be an integer 0..${MAX_GOALS}` }, 400);
    }
  }
  for (const [label, mins, count] of [
    ["homeGoalMinutes", homeGoalMinutes, homeGoals],
    ["awayGoalMinutes", awayGoalMinutes, awayGoals],
  ] as const) {
    if (!Array.isArray(mins) || mins.length !== count) {
      return json({ error: `${label} must be an array of length ${count}` }, 400);
    }
    for (const mm of mins) {
      if (!Number.isInteger(mm) || mm < 1 || mm > MAX_MINUTE) {
        return json({ error: `${label} entries must be integers 1..${MAX_MINUTE}` }, 400);
      }
    }
  }

  const result = setResult(m.ref, homeGoals, awayGoals, homeGoalMinutes, awayGoalMinutes);

  // Resolution is the one moment Rooms learns the outcome: push the scored board
  // (placements + rewards only — never picks). Non-fatal; surface the push status
  // so the operator can re-resolve to retry if Rooms was briefly unreachable.
  const roomsClose = await pushClose(result);

  return json({ ...result, roomsClose });
}

export function OPTIONS() {
  return preflight();
}
