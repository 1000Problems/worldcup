"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Live chat backed by /chat/{ref} (Neon Postgres). Transport is polling: we ask
// for messages after a cursor every ~2s and refresh the reaction + presence
// snapshot each time. Posting needs a verified Rooms session (canPost); without
// one the column is read-only.

const RED = "#E20613";
const INK = "#15161A";
const EMOJIS = ["😂", "🔥", "⚽", "😭", "🐐", "💀"];
const PRESETS = ["Easy win 😤", "No chance 💀", "Upset szn 🟢", "GOAT behavior 🐐", "🔥🔥🔥", "cope harder 😭"];
const AV_COLORS = ["#E20613", "#009E60", "#7A4EE0", "#1F6FEB", "#F5841F", "#15161A", "#0E9488", "#D4357A"];

interface Message {
  id: number;
  player_id: string;
  display_name: string;
  body: string;
  created_at: string;
}
type ReactionSnapshot = Record<string, Record<string, { count: number; mine: boolean }>>;

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Props {
  matchRef: string;
  canPost: boolean;
  playerId: string | null;
  height: string;
}

export default function BanterBox({ matchRef, canPost, playerId, height }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<ReactionSnapshot>({});
  const [online, setOnline] = useState(0);
  const [draft, setDraft] = useState("");
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSeenCount = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/chat/${matchRef}?since=${sinceRef.current}`).then((res) => res.json());
      if (r?.error) {
        setOffline(true);
        return;
      }
      setOffline(false);
      const incoming: Message[] = Array.isArray(r.messages) ? r.messages : [];
      if (incoming.length) {
        sinceRef.current = Math.max(sinceRef.current, ...incoming.map((m) => m.id));
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...incoming.filter((m) => !seen.has(m.id))];
        });
      }
      setReactions(r.reactions ?? {});
      setOnline(typeof r.online === "number" ? r.online : 0);
    } catch {
      setOffline(true);
    }
  }, [matchRef]);

  // Poll + heartbeat, paused while the tab is hidden.
  useEffect(() => {
    let pollT: ReturnType<typeof setInterval> | null = null;
    let pingT: ReturnType<typeof setInterval> | null = null;
    const ping = () => canPost && fetch(`/chat/${matchRef}/ping`, { method: "POST" }).catch(() => {});

    const start = () => {
      if (pollT) return;
      refresh();
      ping();
      pollT = setInterval(refresh, 2000);
      pingT = setInterval(ping, 20000);
    };
    const stop = () => {
      if (pollT) clearInterval(pollT);
      if (pingT) clearInterval(pingT);
      pollT = pingT = null;
    };
    const onVis = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [matchRef, canPost, refresh]);

  // Keep the transcript pinned to the bottom as new messages arrive.
  useEffect(() => {
    if (messages.length !== lastSeenCount.current) {
      lastSeenCount.current = messages.length;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || !canPost) return;
    setDraft("");
    try {
      const row = await fetch(`/chat/${matchRef}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }).then((r) => r.json());
      if (row?.id) {
        sinceRef.current = Math.max(sinceRef.current, row.id);
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      }
    } catch {
      /* next poll will catch up */
    }
  }

  async function react(messageId: number, emoji: string) {
    setPickerFor(null);
    if (!canPost) return;
    try {
      await fetch(`/chat/${matchRef}/react`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, emoji }),
      });
      refresh();
    } catch {
      /* ignore */
    }
  }

  return (
    <section style={S.card(height)}>
      <div style={S.header}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <span style={S.liveDot} />
            <span style={S.kicker}>Live banter</span>
          </div>
          <div style={S.title}>Banter Box</div>
        </div>
        <div style={S.onlinePill}>
          <span style={{ ...S.pulse, background: "#009E60" }} />
          <span style={{ fontWeight: 700, fontSize: 12, color: "#008A54" }}>{online} live</span>
        </div>
      </div>

      <div ref={scrollRef} style={S.scroll}>
        {messages.length === 0 && (
          <p style={{ color: "#9b9ea6", fontWeight: 600, fontSize: 13, textAlign: "center", margin: "auto" }}>
            {offline ? "Chat is offline right now." : "No banter yet — be the first to talk smack."}
          </p>
        )}
        {messages.map((m) => {
          const mine = playerId != null && m.player_id === playerId;
          const rx = reactions[String(m.id)] ?? {};
          const entries = Object.entries(rx).filter(([, v]) => v.count > 0);
          return (
            <div key={m.id} style={{ display: "flex", gap: 9, alignItems: "flex-start", ...(mine ? { flexDirection: "row-reverse" } : {}) }}>
              <div style={S.avatar(avatarColor(m.player_id))}>{initials(m.display_name)}</div>
              <div style={{ display: "flex", flexDirection: "column", maxWidth: "78%", alignItems: mine ? "flex-end" : "flex-start" }}>
                <div style={S.meta}>{`${mine ? "You" : m.display_name} · ${clock(m.created_at)}`}</div>
                <div style={S.bubble(mine)}>{m.body}</div>
                <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap", ...(mine ? { justifyContent: "flex-end" } : {}) }}>
                  {entries.map(([emoji, v]) => (
                    <button key={emoji} onClick={() => react(m.id, emoji)} style={S.reactPill(v.mine)} disabled={!canPost}>
                      {emoji} {v.count}
                    </button>
                  ))}
                  {canPost && (
                    <button onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)} style={S.addReact}>
                      ＋
                    </button>
                  )}
                </div>
                {pickerFor === m.id && (
                  <div style={S.picker}>
                    {EMOJIS.map((e) => (
                      <button key={e} onClick={() => react(m.id, e)} style={S.pickerBtn}>
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canPost ? (
        <>
          <div style={S.presetRow}>
            {PRESETS.map((p) => (
              <button key={p} onClick={() => send(p)} style={S.presetChip}>
                {p}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, padding: "8px 14px 14px", flexShrink: 0 }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  send(draft);
                }
              }}
              placeholder="Talk some smack…"
              style={S.input}
            />
            <button onClick={() => send(draft)} style={S.sendBtn}>
              Send
            </button>
          </div>
        </>
      ) : (
        <div style={S.readOnly}>👀 You&apos;re spectating. Open this room from Rooms to join the banter.</div>
      )}
    </section>
  );
}

const S = {
  card: (height: string): React.CSSProperties => ({
    background: "#fff",
    border: "1px solid rgba(21,22,26,.08)",
    borderRadius: 16,
    boxShadow: "0 1px 2px rgba(21,22,26,.04),0 14px 34px rgba(21,22,26,.07)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    height,
  }),
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "15px 18px",
    borderBottom: "1px solid rgba(21,22,26,.08)",
    flexShrink: 0,
  } as React.CSSProperties,
  liveDot: { width: 6, height: 6, borderRadius: "50%", background: RED, display: "inline-block" } as React.CSSProperties,
  kicker: {
    fontFamily: "'Oswald',sans-serif",
    fontWeight: 600,
    fontSize: 11,
    letterSpacing: ".12em",
    textTransform: "uppercase",
    color: RED,
  } as React.CSSProperties,
  title: {
    fontFamily: "'Oswald',sans-serif",
    fontWeight: 600,
    fontSize: 19,
    textTransform: "uppercase",
    letterSpacing: ".01em",
    lineHeight: 1,
  } as React.CSSProperties,
  onlinePill: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    background: "#E6F6EF",
    borderRadius: 30,
    padding: "5px 11px 5px 9px",
  } as React.CSSProperties,
  pulse: { width: 8, height: 8, borderRadius: "50%", display: "inline-block", animation: "gr-ping 2s infinite" } as React.CSSProperties,
  scroll: {
    flex: 1,
    overflowY: "auto",
    padding: "18px 16px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 15,
    minHeight: 0,
  } as React.CSSProperties,
  avatar: (bg: string): React.CSSProperties => ({
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: bg,
    color: "#fff",
    border: "2px solid #fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
    boxShadow: "0 2px 6px rgba(21,22,26,.16)",
  }),
  meta: {
    fontSize: 10.5,
    fontWeight: 700,
    color: "#9b9ea6",
    margin: "0 3px 3px",
    textTransform: "uppercase",
    letterSpacing: ".04em",
  } as React.CSSProperties,
  bubble: (mine: boolean): React.CSSProperties => ({
    borderRadius: 14,
    padding: "9px 13px",
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.4,
    background: mine ? INK : "#F1F2F4",
    color: mine ? "#fff" : INK,
    ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }),
  }),
  reactPill: (mine: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    border: `1px solid ${mine ? RED : "rgba(21,22,26,.12)"}`,
    borderRadius: 20,
    padding: "1px 8px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    background: mine ? "#FCEAEB" : "#fff",
    color: mine ? RED : INK,
  }),
  addReact: {
    border: "1px dashed rgba(21,22,26,.2)",
    background: "#fff",
    borderRadius: 20,
    width: 24,
    height: 22,
    fontSize: 13,
    color: "#9b9ea6",
    cursor: "pointer",
    lineHeight: 1,
  } as React.CSSProperties,
  picker: {
    display: "flex",
    gap: 4,
    marginTop: 6,
    background: "#fff",
    border: "1px solid rgba(21,22,26,.12)",
    borderRadius: 11,
    padding: "5px 8px",
    boxShadow: "0 6px 18px rgba(21,22,26,.14)",
    width: "max-content",
    animation: "gr-rise .15s ease-out",
  } as React.CSSProperties,
  pickerBtn: {
    background: "none",
    border: "none",
    fontSize: 19,
    cursor: "pointer",
    padding: "2px 3px",
    lineHeight: 1,
    borderRadius: 7,
  } as React.CSSProperties,
  presetRow: { display: "flex", gap: 6, flexWrap: "wrap", padding: "12px 14px 4px", flexShrink: 0 } as React.CSSProperties,
  presetChip: {
    border: "1px solid rgba(21,22,26,.12)",
    background: "#fff",
    borderRadius: 20,
    padding: "6px 12px",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    color: "#3a3d45",
  } as React.CSSProperties,
  input: {
    flex: 1,
    border: "1px solid rgba(21,22,26,.14)",
    borderRadius: 11,
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 500,
    outline: "none",
    background: "#fff",
  } as React.CSSProperties,
  sendBtn: {
    background: RED,
    color: "#fff",
    border: "none",
    borderRadius: 11,
    padding: "0 18px",
    fontFamily: "'Oswald',sans-serif",
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: ".04em",
    textTransform: "uppercase",
    cursor: "pointer",
  } as React.CSSProperties,
  readOnly: {
    margin: "0 14px 14px",
    background: "#F4F5F7",
    borderRadius: 12,
    padding: "14px 16px",
    fontWeight: 600,
    fontSize: 13,
    color: "#6B6E76",
    textAlign: "center",
    lineHeight: 1.5,
    flexShrink: 0,
  } as React.CSSProperties,
};
