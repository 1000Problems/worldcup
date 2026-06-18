import type { NextRequest } from "next/server";
import { json } from "@/lib/http";
import { sql, ensureSchema } from "@/lib/db";
import { getChatSession } from "@/lib/chatSession";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["😂", "🔥", "⚽", "😭", "🐐", "💀"]);

// POST /chat/{ref}/react { messageId, emoji } — toggle the caller's reaction.
export async function POST(req: NextRequest, { params }: { params: { ref: string } }) {
  const session = getChatSession();
  if (!session) return json({ error: "sign in via Rooms to react" }, 401);

  const payload = await req.json().catch(() => null);
  const messageId = Number(payload?.messageId);
  const emoji = String(payload?.emoji ?? "");
  if (!Number.isInteger(messageId) || !ALLOWED.has(emoji)) {
    return json({ error: "expected { messageId, emoji }" }, 400);
  }

  try {
    await ensureSchema();
    const db = sql();
    // Toggle: remove if present, otherwise add. Reaction rows belonging to other
    // refs can't collide because messageId is globally unique.
    const removed = await db`
      delete from chat_reaction
      where message_id = ${messageId} and player_id = ${session.playerId} and emoji = ${emoji}
      returning message_id`;
    if ((removed as unknown[]).length === 0) {
      await db`
        insert into chat_reaction (message_id, player_id, emoji)
        values (${messageId}, ${session.playerId}, ${emoji})
        on conflict do nothing`;
      return json({ messageId, emoji, mine: true });
    }
    return json({ messageId, emoji, mine: false });
  } catch (e) {
    return json({ error: "chat unavailable", detail: String(e instanceof Error ? e.message : e) }, 503);
  }
}
