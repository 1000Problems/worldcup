import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { getMatch, validatePick } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// POST /validate { event, pick } — is this a legal pick? Pure.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ valid: false, reason: "invalid JSON body" }, 400);

  const ref: string | undefined = body.event ?? body.ref;
  const m = ref ? getMatch(ref) : null;
  if (!m) return json({ valid: false, reason: "unknown event ref" }, 404);

  return json(validatePick(m, body.pick));
}

export function OPTIONS() {
  return preflight();
}
