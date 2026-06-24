import type { NextRequest } from "next/server";
import { json } from "@/lib/http";
import { sql, ensureSchema } from "@/lib/db";
import { getChatSession } from "@/lib/chatSession";
import { matchOnlineCount } from "@/lib/presence";

export const dynamic = "force-dynamic";

// GET /chat/{ref}?since={id}
//   → { messages: [...new], reactions: {msgId:{emoji:{count,mine}}}, online }
// Messages are an append cursor (id > since); reactions + presence are a fresh
// snapshot over the most recent window each poll, so reactions on older messages
// and online counts stay live without a delta protocol.
export async function GET(req: NextRequest, { params }: { params: { ref: string } }) {
  const ref = params.ref;
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0") || 0;
  const me = getChatSession()?.playerId ?? null;

  try {
    await ensureSchema();
    const db = sql();

    const messages = await db`
      select id, player_id, display_name, body, created_at
      from chat_message
      where match_ref = ${ref} and id > ${since}
      order by id asc
      limit 200`;

    const reactionRows = await db`
      select message_id, emoji, count(*)::int as count,
             bool_or(player_id = ${me}) as mine
      from chat_reaction
      where message_id in (
        select id from chat_message where match_ref = ${ref} order by id desc limit 100
      )
      group by message_id, emoji`;

    const reactions: Record<string, Record<string, { count: number; mine: boolean }>> = {};
    for (const r of reactionRows as Array<{ message_id: number; emoji: string; count: number; mine: boolean | null }>) {
      const key = String(r.message_id);
      (reactions[key] ||= {})[r.emoji] = { count: r.count, mine: r.mine === true };
    }

    // Online count now comes from the unified presence table (worldcup_presence),
    // written by the /presence/beat heartbeat — one source of truth shared with the
    // lobby/match rails. The old chat_presence ping path is retired.
    const online = await matchOnlineCount(ref);

    return json({ messages, reactions, online });
  } catch (e) {
    return json({ error: "chat unavailable", detail: String(e instanceof Error ? e.message : e) }, 503);
  }
}

// POST /chat/{ref} { body } — insert a message as the verified cookie player.
// Identity is server-trusted; any player_id in the request body is ignored.
export async function POST(req: NextRequest, { params }: { params: { ref: string } }) {
  const session = getChatSession();
  if (!session) return json({ error: "sign in via Rooms to chat" }, 401);

  const payload = await req.json().catch(() => null);
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) return json({ error: "empty message" }, 400);
  if (body.length > 500) return json({ error: "message too long" }, 400);

  try {
    await ensureSchema();
    const db = sql();
    const rows = await db`
      insert into chat_message (match_ref, player_id, display_name, body)
      values (${params.ref}, ${session.playerId}, ${session.displayName}, ${body})
      returning id, player_id, display_name, body, created_at`;
    return json((rows as unknown[])[0]);
  } catch (e) {
    return json({ error: "chat unavailable", detail: String(e instanceof Error ? e.message : e) }, 503);
  }
}
