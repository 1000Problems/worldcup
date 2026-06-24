"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Presence rail — the "who's here" column for the GoalRush lobby and each match.
//
// Two pieces, both polling-based and paused while the tab is hidden (mirrors the
// BanterBox cadence so we never run two different polling patterns):
//   - useHeartbeat(matchRef?)  POSTs /presence/beat to register the player.
//   - PresenceRail              GETs /presence and renders the live roster.
// Identity is server-trusted; the client sends no name. An unverified visitor
// (dev stub) sees the rail but never appears in it.
// ---------------------------------------------------------------------------

const RED = "#E20613";
const INK = "#15161A";
const MUT = "#6B6E76";
const GREEN = "#009E60";
const LINE = "rgba(21,22,26,.08)";
const AV_COLORS = ["#E20613", "#009E60", "#7A4EE0", "#1F6FEB", "#F5841F", "#15161A", "#0E9488", "#D4357A"];
const OSW = "'Oswald',sans-serif";

const BEAT_MS = 15000;
const POLL_MS = 5000;

interface Person {
  playerId: string;
  name: string;
  avatar: string | null;
  since: string;
}
interface Snapshot {
  online: Person[];
  onlineCount: number;
  everCount: number;
}

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

// Register the player's presence: always the lobby, plus the match when given.
// No-ops server-side without a verified session, so it's safe to always mount.
export function useHeartbeat(matchRef?: string | null) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const beat = () =>
      fetch("/presence/beat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(matchRef ? { matchRef } : {}),
      }).catch(() => {});

    const start = () => {
      if (timer) return;
      beat();
      timer = setInterval(beat, BEAT_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [matchRef]);
}

export function usePresence(scope: "series" | "match", id: string) {
  const [snap, setSnap] = useState<Snapshot>({ online: [], onlineCount: 0, everCount: 0 });
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/presence?scope=${scope}&id=${encodeURIComponent(id)}`).then((res) => res.json());
      if (r?.error) {
        setOffline(true);
        return;
      }
      setOffline(false);
      setSnap({
        online: Array.isArray(r.online) ? r.online : [],
        onlineCount: typeof r.onlineCount === "number" ? r.onlineCount : 0,
        everCount: typeof r.everCount === "number" ? r.everCount : 0,
      });
    } catch {
      setOffline(true);
    }
  }, [scope, id]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  return { ...snap, offline };
}

interface RailProps {
  scope: "series" | "match";
  id: string;
  title: string;
  everLabel: string; // singular/base noun, e.g. "have played" → "312 have played"
  youId?: string | null;
  compact?: boolean; // narrow layout (horizontal strip)
}

export default function PresenceRail({ scope, id, title, everLabel, youId, compact }: RailProps) {
  const { online, onlineCount, everCount, offline } = usePresence(scope, id);

  return (
    <aside
      style={{
        background: "#fff",
        border: `1px solid ${LINE}`,
        borderRadius: 16,
        boxShadow: "0 1px 2px rgba(21,22,26,.04),0 14px 34px rgba(21,22,26,.07)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${LINE}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: RED }} />
            <span style={{ fontFamily: OSW, fontWeight: 600, fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: RED }}>Who&apos;s here</span>
          </div>
          <div style={{ fontFamily: OSW, fontWeight: 600, fontSize: 18, textTransform: "uppercase", letterSpacing: ".01em", lineHeight: 1 }}>{title}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: "#E6F6EF", borderRadius: 30, padding: "5px 11px 5px 9px", flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN, animation: "gr-ping 2s infinite" }} />
          <span style={{ fontWeight: 700, fontSize: 12, color: "#008A54" }}>{onlineCount} live</span>
        </div>
      </div>

      <div
        style={{
          padding: compact ? "10px 12px" : "12px 14px",
          display: compact ? "flex" : "block",
          flexWrap: compact ? "wrap" : undefined,
          gap: compact ? 8 : 0,
          maxHeight: compact ? undefined : 360,
          overflowY: compact ? undefined : "auto",
          flex: 1,
          minHeight: 0,
        }}
      >
        {online.length === 0 ? (
          <p style={{ color: "#9b9ea6", fontWeight: 600, fontSize: 13, textAlign: "center", padding: "20px 8px", margin: 0, width: "100%" }}>
            {offline ? "Roster offline right now." : "Be the first one in. ⚽"}
          </p>
        ) : (
          online.map((p) => {
            const you = youId != null && p.playerId === youId;
            return (
              <div
                key={p.playerId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: compact ? "6px 10px 6px 6px" : "7px 8px",
                  borderRadius: 11,
                  background: you ? "#FFF7F7" : "transparent",
                  border: you ? `1px solid ${RED}` : "1px solid transparent",
                  marginBottom: compact ? 0 : 2,
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    background: avatarColor(p.playerId),
                    color: "#fff",
                    border: "2px solid #fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    flexShrink: 0,
                    boxShadow: "0 2px 6px rgba(21,22,26,.16)",
                  }}
                >
                  {initials(p.name)}
                </div>
                <span style={{ fontWeight: 600, fontSize: 14, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: compact ? 120 : 180 }}>
                  {you ? "You" : p.name}
                </span>
              </div>
            );
          })
        )}
        {onlineCount > online.length && (
          <p style={{ color: MUT, fontWeight: 600, fontSize: 12.5, padding: "6px 8px 0", margin: 0 }}>+{onlineCount - online.length} more live</p>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${LINE}`, background: "rgba(21,22,26,.015)", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: OSW, fontWeight: 700, fontSize: 16, color: INK }}>{everCount.toLocaleString()}</span>
        <span style={{ fontSize: 12.5, color: MUT, fontWeight: 600 }}>{everLabel}</span>
      </div>
    </aside>
  );
}

// Lobby wrapper: runs the lobby heartbeat (no match) and renders the series rail.
// Mounted by the server-rendered Landing, which already greets the player by name.
export function LobbyPresence({ seriesId, youId, compact }: { seriesId: string; youId?: string | null; compact?: boolean }) {
  useHeartbeat(null);
  return <PresenceRail scope="series" id={seriesId} title="In the room" everLabel="have played GoalRush" youId={youId} compact={compact} />;
}
