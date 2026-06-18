import type { NextRequest } from "next/server";
import { json } from "@/lib/http";
import { sql, ensureSchema } from "@/lib/db";
import { getChatSession } from "@/lib/chatSession";

export const dynamic = "force-dynamic";

// POST /chat/{ref}/ping — presence heartbeat. Only verified players count
// toward "online"; the dev stub can read chat but never registers presence.
export async function POST(_req: NextRequest, { params }: { params: { ref: string } }) {
  const session = getChatSession();
  if (!session) return json({ online: false });

  try {
    await ensureSchema();
    const db = sql();
    await db`
      insert into chat_presence (match_ref, player_id, last_seen)
      values (${params.ref}, ${session.playerId}, now())
      on conflict (match_ref, player_id) do update set last_seen = now()`;
    return json({ online: true });
  } catch (e) {
    return json({ error: "chat unavailable", detail: String(e instanceof Error ? e.message : e) }, 503);
  }
}
