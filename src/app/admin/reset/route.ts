import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, reset, phaseFor } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// POST /admin/reset { ref } — dev control: wipe OUR state (posted result + manual
// lock) so the room returns to `open`. Rooms owns the picks — those reset on the
// Rooms side, not here. Gated by ADMIN_TOKEN (Bearer).
export async function POST(req: NextRequest) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return json({ error: "ADMIN_TOKEN not configured" }, 500);
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await req.json().catch(() => null);
  const ref: string | undefined = body?.ref;
  const m = ref ? getMatch(ref) : null;
  if (!m) return json({ error: "unknown event ref" }, 404);

  reset(m.ref);
  return json({ ref: m.ref, phase: phaseFor(m) });
}

export function OPTIONS() {
  return preflight();
}
