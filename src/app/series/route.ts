import type { NextRequest } from "next/server";
import { json, preflight } from "@/lib/http";
import { listSeries, seriesPhase } from "@/lib/rooms";

export const dynamic = "force-dynamic";

// GET /series — the catalogue of tournaments the host can enumerate. One entry
// per series with a count and the rolled-up phase; the hub payload lives at
// /series/{sref}.
export async function GET(_req: NextRequest) {
  const out = await Promise.all(
    listSeries().map(async (s) => ({
      ref: s.ref,
      display: s.display,
      eventCount: s.eventRefs.length,
      phase: await seriesPhase(s.ref),
    })),
  );
  return json(out);
}

export function OPTIONS() {
  return preflight();
}
