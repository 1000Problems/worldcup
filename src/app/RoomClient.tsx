"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BanterBox from "./BanterBox";
import PresenceRail, { useHeartbeat } from "./PresenceRail";

const RED = "#E20613";
const INK = "#15161A";
const MUT = "#6B6E76";
const LINE = "rgba(21,22,26,.12)";
const MAX_GOALS = 20;
const MAX_MINUTE = 120;

// Home/away get a fixed palette; the *names and codes* come from event data, so
// the same component serves any fixture (one deployment, many matches).
const SIDE = {
  home: { color: "#E20613", tint: "#FCEAEB" },
  away: { color: "#009E60", tint: "#E6F6EF" },
  draw: { color: "#15161A", tint: "#F0F0F2" },
};

interface Team {
  code: string;
  name: string;
}
interface EventData {
  ref: string;
  expectedLockAt: string;
  scoring?: { summary?: string };
  labels: { title: string; competition: string; stage: string; venue: string; home: Team; away: Team };
}
type Phase = "open" | "locked" | "closed";
type Outcome = "HOME" | "DRAW" | "AWAY";

interface ResultDef {
  ref: string;
  homeGoals: number;
  awayGoals: number;
  outcome: Outcome;
  homeGoalMinutes: number[];
  awayGoalMinutes: number[];
  final: true;
}
interface ScoreBreakdown {
  playerId: string;
  points: number;
  detail: {
    outcome: { picked: Outcome; actual: Outcome; correct: boolean };
    score: { picked: string; actual: string; exact: boolean; gdMatch: boolean; totalMatch: boolean };
    timing: { comparable: boolean; error: number };
    bands: { outcome: number; score: number; timing: number };
  };
}
interface Pick {
  homeGoals: number;
  awayGoals: number;
  homeGoalMinutes: number[];
  awayGoalMinutes: number[];
}

interface Player {
  playerId: string;
  displayName: string;
  avatarToken: string;
}
interface Props {
  matchRef: string;
  player: Player | null;
  returnUrl: string | null;
  devName: string | null;
  tokenHint: string;
}
interface MsgEntry {
  t: string;
  origin: string;
  data: unknown;
}
interface GoalSlot {
  id: string;
  side: "home" | "away";
}

function useCountdown(targetISO?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!targetISO) return "";
  const ms = new Date(targetISO).getTime() - now;
  if (ms <= 0) return "Kicked off";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `Locks in ${d}d ${h}h` : `Locks in ${h}h ${m}m`;
}
function outcomeOf(h: number, a: number): Outcome {
  return h > a ? "HOME" : h < a ? "AWAY" : "DRAW";
}
function ord(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function RoomClient({ matchRef, player, returnUrl, devName, tokenHint }: Props) {
  const verified = !!player;
  const displayName = player?.displayName ?? devName ?? null;
  const playerId = player?.playerId ?? null;

  // Register presence for this match (and, server-side, the room). No-ops without a
  // verified session, so the dev stub watches the rail without joining it.
  useHeartbeat(matchRef);

  const env = useMemo(() => {
    if (typeof window === "undefined") return { href: "", query: {} as Record<string, string>, referrer: "", inIframe: false };
    const url = new URL(window.location.href);
    if (url.searchParams.has("t")) url.searchParams.set("t", "***");
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = k === "t" ? "***" : v));
    return { href: url.toString(), query, referrer: document.referrer || "(none)", inIframe: window.parent !== window };
  }, []);

  // Strip the launch token from the address bar (middleware already stashed it
  // in the session cookie) so it can't linger in history or leak via Referer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("t")) {
      url.searchParams.delete("t");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const [event, setEvent] = useState<EventData | null>(null);
  const [phase, setPhase] = useState<Phase>("open");
  const [error, setError] = useState<string | null>(null);
  const [hostMsgs, setHostMsgs] = useState<MsgEntry[]>([]);
  const [lastSent, setLastSent] = useState<unknown>(null);

  const [step, setStep] = useState(1);
  const [winner, setWinner] = useState<Outcome | null>(null);
  const [homeGoals, setHomeGoals] = useState(0);
  const [awayGoals, setAwayGoals] = useState(0);
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const [activeGoal, setActiveGoal] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedPick, setSubmittedPick] = useState<Pick | null>(null);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

  const [isNarrow, setIsNarrow] = useState(false);
  const [mobileTab, setMobileTab] = useState<"predict" | "chat">("predict");
  const [confetti, setConfetti] = useState<Array<{ id: number; left: number; delay: number; dur: number; size: number; col: string; rot: number }>>([]);
  const confT = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dev-only state preview: lets us inspect locked/result views without a real
  // kickoff. Gated to the dev stub so production (verified) launches never see it.
  const devMode = !verified && !!devName;
  const [phaseOverride, setPhaseOverride] = useState<Phase | null>(null);
  const effectivePhase: Phase = phaseOverride ?? phase;

  const [result, setResult] = useState<ResultDef | null>(null);
  const [myScore, setMyScore] = useState<ScoreBreakdown | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setIsNarrow(window.innerWidth < 900);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      setHostMsgs((prev) => [{ t: new Date().toLocaleTimeString(), origin: e.origin, data: e.data }, ...prev].slice(0, 40));
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([fetch(`/event/${matchRef}`).then((r) => r.json()), fetch(`/phase/${matchRef}`).then((r) => r.json())])
      .then(([ev, ph]) => {
        if (!alive) return;
        if (ev?.error) return setError(ev.error);
        setEvent(ev);
        setPhase(ph?.phase ?? "open");
      })
      .catch(() => alive && setError("Could not load the match."));
    return () => {
      alive = false;
    };
  }, [matchRef]);

  // Pull the real-world result + our own scored breakdown when the match closes.
  useEffect(() => {
    if (effectivePhase !== "closed") return;
    let alive = true;
    fetch("/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: matchRef }),
    })
      .then((r) => r.json())
      .then(async (res: ResultDef | null) => {
        if (!alive || !res) {
          setResult(null);
          return;
        }
        setResult(res);
        if (submittedPick) {
          // Score is computed by the pure server scorer — never reimplemented here.
          const board: ScoreBreakdown[] = await fetch("/score", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ result: res, picks: [{ playerId: playerId ?? "you", pick: submittedPick }] }),
          }).then((r) => r.json());
          if (alive) setMyScore(board[0] ?? null);
        }
      })
      .catch(() => alive && setResult(null));
    return () => {
      alive = false;
    };
  }, [effectivePhase, matchRef, submittedPick, playerId]);

  const countdown = useCountdown(event?.expectedLockAt);
  const home = event?.labels.home;
  const away = event?.labels.away;
  const inputsLocked = effectivePhase !== "open" || submitted;

  function goalSlots(h: number, a: number): GoalSlot[] {
    const s: GoalSlot[] = [];
    for (let i = 0; i < h; i++) s.push({ id: "H" + i, side: "home" });
    for (let i = 0; i < a; i++) s.push({ id: "A" + i, side: "away" });
    return s;
  }
  const slots = goalSlots(homeGoals, awayGoals);
  const totalGoals = homeGoals + awayGoals;
  const allPlaced = slots.every((s) => minutes[s.id] != null);
  const canLock = effectivePhase === "open" && !submitted && winner != null && allPlaced;

  function pickWinner(o: Outcome) {
    if (inputsLocked) return;
    const map: Record<Outcome, [number, number]> = { HOME: [1, 0], DRAW: [1, 1], AWAY: [0, 1] };
    const [h, a] = map[o];
    setWinner(o);
    setHomeGoals(h);
    setAwayGoals(a);
    setMinutes({});
    setActiveGoal(null);
    setStep(2);
  }
  function changeGoal(side: "home" | "away", delta: number) {
    if (inputsLocked) return;
    const h = side === "home" ? Math.max(0, Math.min(MAX_GOALS, homeGoals + delta)) : homeGoals;
    const a = side === "away" ? Math.max(0, Math.min(MAX_GOALS, awayGoals + delta)) : awayGoals;
    const valid = new Set(goalSlots(h, a).map((s) => s.id));
    const next: Record<string, number> = {};
    Object.keys(minutes).forEach((k) => {
      if (valid.has(k)) next[k] = minutes[k];
    });
    setHomeGoals(h);
    setAwayGoals(a);
    setMinutes(next);
    setWinner(outcomeOf(h, a));
    setActiveGoal(null);
  }
  function goStep(n: number) {
    setStep(n);
    if (n === 3) {
      const slot = goalSlots(homeGoals, awayGoals).find((s) => minutes[s.id] == null);
      setActiveGoal(slot ? slot.id : null);
    }
  }
  function clearGoal(id: string) {
    setMinutes((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    setActiveGoal(id);
  }
  function onTimeline(e: React.MouseEvent<HTMLDivElement>) {
    if (inputsLocked) return;
    const r = e.currentTarget.getBoundingClientRect();
    const minute = Math.max(1, Math.min(MAX_MINUTE, Math.round(((e.clientX - r.left) / r.width) * MAX_MINUTE)));
    let active = activeGoal;
    if (active == null || minutes[active] != null) {
      const slot = slots.find((s) => minutes[s.id] == null);
      active = slot ? slot.id : active;
    }
    if (active == null) return;
    const nextMin = { ...minutes, [active]: minute };
    const nextSlot = slots.find((s) => nextMin[s.id] == null);
    setMinutes(nextMin);
    setActiveGoal(nextSlot ? nextSlot.id : null);
  }

  function makeConfetti() {
    const cols = [RED, "#009E60", INK, "#FFC400", "#1F6FEB", "#F5841F"];
    return Array.from({ length: 70 }).map((_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      dur: 1.7 + Math.random() * 1.4,
      size: 7 + Math.random() * 8,
      col: cols[i % cols.length],
      rot: Math.random() * 360,
    }));
  }

  async function lockIn() {
    if (!canLock || !home || !away) return;
    const espMins = slots.filter((s) => s.side === "home").map((s) => minutes[s.id]).sort((x, y) => x - y);
    const ksaMins = slots.filter((s) => s.side === "away").map((s) => minutes[s.id]).sort((x, y) => x - y);
    const pick: Pick = { homeGoals, awayGoals, homeGoalMinutes: espMins, awayGoalMinutes: ksaMins };

    try {
      const res = await fetch("/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: matchRef, pick }),
      }).then((r) => r.json());
      if (!res.valid) {
        setValidateMsg(res.reason ?? "Invalid pick.");
        return;
      }
    } catch {
      setValidateMsg("Could not reach the validator.");
      return;
    }

    // Persist the pick to OUR private store. It never leaves worldcup — Rooms
    // only ever learns the outcome at /close, never the prediction itself.
    if (verified) {
      fetch("/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: matchRef, pick }),
      }).catch(() => {});
    }

    // Signal the host that this player locked in — WITHOUT the pick contents.
    const payload = { type: "rooms:locked", ref: matchRef, playerId };
    setLastSent(payload);
    if (typeof window !== "undefined" && window.parent !== window) window.parent.postMessage(payload, "*");

    setSubmitted(true);
    setSubmittedPick(pick);
    setValidateMsg(null);
    setConfetti(makeConfetti());
    if (confT.current) clearTimeout(confT.current);
    confT.current = setTimeout(() => setConfetti([]), 2700);

    // Announce the lock to the room WITHOUT revealing the pick — guesses stay
    // sealed until full time so nobody can copy or counter another player.
    if (verified) {
      fetch(`/chat/${matchRef}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "🔒 Locked in my pick — sealed till full time." }),
      }).catch(() => {});
    }
  }

  const showPredict = !isNarrow || mobileTab === "predict";
  const showChat = !isNarrow || mobileTab === "chat";
  const chatHeight = isNarrow ? "72vh" : "660px";

  const statusChip: [string, string] =
    effectivePhase === "open" ? ["⏱️", countdown || "Locks soon"] : effectivePhase === "locked" ? ["🔴", "LIVE · kick-off"] : ["🏁", "Full time"];

  return (
    <div style={{ minHeight: "100vh", paddingBottom: 34 }}>
      <div style={{ height: 5, background: RED }} />

      {confetti.length > 0 && (
        <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 60, overflow: "hidden" }}>
          {confetti.map((c) => (
            <div
              key={c.id}
              style={{
                position: "absolute",
                top: -24,
                left: `${c.left}%`,
                width: c.size,
                height: c.size * 0.6,
                background: c.col,
                borderRadius: 2,
                transform: `rotate(${c.rot}deg)`,
                animation: `gr-fall ${c.dur}s linear ${c.delay}s forwards`,
              }}
            />
          ))}
        </div>
      )}

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "20px 18px 0" }}>
        {/* HEADER */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: RED, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 23, boxShadow: "0 4px 12px rgba(226,6,19,.32)" }}>⚽</div>
            <div>
              <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 700, fontSize: 24, letterSpacing: ".01em", lineHeight: 0.95, textTransform: "uppercase" }}>
                GOAL<span style={{ color: RED }}>RUSH</span>
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: MUT, letterSpacing: ".02em", marginTop: 1 }}>
                {displayName ? `Hello, ${displayName}${verified ? "" : " · guest"}` : "Predict · banter · win the room"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, background: "#fff", border: `1px solid rgba(21,22,26,.1)`, borderRadius: 11, padding: "8px 12px", fontWeight: 600, fontSize: 13 }}>
              {statusChip[0]} <span>{statusChip[1]}</span>
            </div>
            {verified && returnUrl && (
              <a href={returnUrl} style={{ fontSize: 13, fontWeight: 600, color: MUT, textDecoration: "none", background: "#fff", border: `1px solid rgba(21,22,26,.1)`, borderRadius: 11, padding: "8px 12px" }}>
                ← Return to Rooms
              </a>
            )}
          </div>
        </div>

        {/* dev-only state preview */}
        {devMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
            <span style={{ fontFamily: "'Oswald',sans-serif", fontSize: 10, fontWeight: 600, letterSpacing: ".12em", color: "#b0b3ba", textTransform: "uppercase" }}>Dev preview</span>
            <div style={{ display: "flex", background: "#F4F5F7", borderRadius: 9, padding: 3, gap: 3 }}>
              {(["open", "locked", "closed"] as Phase[]).map((p) => {
                const on = effectivePhase === p;
                const label = p === "open" ? "Pre-match" : p === "locked" ? "Kick-off" : "Full-time";
                return (
                  <button
                    key={p}
                    onClick={() => setPhaseOverride(p)}
                    style={{ border: "none", borderRadius: 7, padding: "7px 12px", fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 11, letterSpacing: ".03em", textTransform: "uppercase", cursor: "pointer", background: on ? "#fff" : "transparent", color: on ? RED : "#9b9ea6", boxShadow: on ? "0 1px 3px rgba(21,22,26,.14)" : "none" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* MOBILE TABS */}
        {isNarrow && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {(["predict", "chat"] as const).map((t) => {
              const on = mobileTab === t;
              const label = t === "predict" ? (effectivePhase === "closed" ? "🏆 RESULT" : "🎯 PREDICT") : "💬 BANTER";
              return (
                <button key={t} onClick={() => setMobileTab(t)} style={{ flex: 1, border: `1px solid ${on ? RED : "rgba(21,22,26,.1)"}`, borderRadius: 11, padding: 11, fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 14, letterSpacing: ".04em", textTransform: "uppercase", cursor: "pointer", background: on ? RED : "#fff", color: on ? "#fff" : MUT }}>
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {/* WHO'S IN THIS MATCH — everyone who entered Spain–Uruguay, picked or not. */}
        <div style={{ marginBottom: 16 }}>
          <PresenceRail scope="match" id={matchRef} title="In this match" everLabel="have joined this match" youId={verified ? playerId : null} compact />
        </div>

        {error ? (
          <p style={{ textAlign: "center", color: MUT, padding: 40 }}>{error}</p>
        ) : !event || !home || !away ? (
          <p style={{ textAlign: "center", color: MUT, padding: 40 }}>Loading…</p>
        ) : (
          <div style={isNarrow ? { display: "block" } : { display: "grid", gridTemplateColumns: "minmax(0,470px) minmax(0,1fr)", gap: 18, alignItems: "start" }}>
            {/* ===== PREDICT COLUMN ===== */}
            {showPredict && (
              <section style={{ background: "#fff", border: "1px solid rgba(21,22,26,.08)", borderRadius: 16, boxShadow: "0 1px 2px rgba(21,22,26,.04),0 14px 34px rgba(21,22,26,.07)", overflow: "hidden", marginBottom: isNarrow ? 18 : 0 }}>
                {/* fixture banner */}
                <div style={{ padding: "16px 20px 18px", borderBottom: "1px solid rgba(21,22,26,.08)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: RED }} />
                    <span style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: RED }}>
                      {event.labels.competition} · {event.labels.stage}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11, flex: 1, minWidth: 0 }}>
                      <Crest side="home" code={home.code} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 18, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{home.name}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "center", flexShrink: 0 }}>
                      <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 700, fontSize: 13, color: "#9b9ea6", letterSpacing: ".08em" }}>{effectivePhase === "closed" && result ? `${result.homeGoals}–${result.awayGoals}` : "VS"}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 11, flex: 1, minWidth: 0, justifyContent: "flex-end", textAlign: "right" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 18, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{away.name}</div>
                      </div>
                      <Crest side="away" code={away.code} />
                    </div>
                  </div>
                </div>

                <div style={{ padding: 20 }}>
                  {/* ===== WIZARD (open, not submitted) ===== */}
                  {effectivePhase === "open" && !submitted && (
                    <>
                      <div style={{ display: "flex", gap: 7, marginBottom: 20 }}>
                        {["WHO WINS", "THE SCORE", "GOAL TIMES"].map((label, i) => {
                          const num = i + 1;
                          const active = step === num;
                          const done = step > num;
                          const bg = active ? RED : done ? "#FCEAEB" : "#F4F5F7";
                          const col = active ? "#fff" : done ? RED : "#9b9ea6";
                          return (
                            <button key={label} onClick={() => goStep(num)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", border: "none", borderRadius: 9, padding: "9px 4px", background: bg, color: col, fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 11.5, letterSpacing: ".04em", textTransform: "uppercase" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 17, height: 17, borderRadius: "50%", background: active ? "rgba(255,255,255,.25)" : done ? RED : "#dcdee2", color: active || done ? "#fff" : "#9b9ea6", fontSize: 10.5, fontWeight: 700 }}>{num}</span>
                              <span>{label}</span>
                            </button>
                          );
                        })}
                      </div>

                      {step === 1 && (
                        <>
                          <h2 style={H2}>Who takes the win?</h2>
                          <p style={SUB}>Trust your gut — you&apos;ll fine-tune the exact score next.</p>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {(
                              [
                                ["HOME", home.name, home.code, SIDE.home],
                                ["DRAW", "Draw", "=", SIDE.draw],
                                ["AWAY", away.name, away.code, SIDE.away],
                              ] as [Outcome, string, string, { color: string; tint: string }][]
                            ).map(([o, label, code, c]) => {
                              const sel = winner === o;
                              return (
                                <button key={o} onClick={() => pickWinner(o)} style={{ position: "relative", flex: 1, minWidth: 90, cursor: "pointer", padding: "16px 10px 14px", textAlign: "center", border: `1.5px solid ${sel ? c.color : "rgba(21,22,26,.1)"}`, borderRadius: 13, background: sel ? c.tint : "#fff" }}>
                                  {sel && <span style={{ position: "absolute", top: 8, right: 8, width: 19, height: 19, borderRadius: "50%", background: c.color, color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>✓</span>}
                                  <div style={{ width: 48, height: 48, margin: "0 auto 9px", borderRadius: 12, background: sel ? "#fff" : c.tint, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, color: c.color, fontFamily: "'Oswald',sans-serif" }}>{o === "DRAW" ? "🤝" : code}</div>
                                  <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 15, textTransform: "uppercase", letterSpacing: ".02em", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                                </button>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {step === 2 && (
                        <>
                          <h2 style={H2}>Call the exact score</h2>
                          <p style={SUB}>Nailing the exact scoreline is worth the most points.</p>
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <ScoreRow side="home" team={home} goals={homeGoals} onMinus={() => changeGoal("home", -1)} onPlus={() => changeGoal("home", 1)} />
                            <ScoreRow side="away" team={away} goals={awayGoals} onMinus={() => changeGoal("away", -1)} onPlus={() => changeGoal("away", 1)} />
                          </div>
                          <div style={{ textAlign: "center", marginTop: 18 }}>
                            <OutcomePill home={home} away={away} h={homeGoals} a={awayGoals} />
                          </div>
                        </>
                      )}

                      {step === 3 && (
                        <>
                          <h2 style={H2}>When do they go in?</h2>
                          <p style={SUB}>Tap the timeline to place each goal&apos;s minute (1–{MAX_MINUTE}).</p>
                          {totalGoals === 0 ? (
                            <div style={{ textAlign: "center", padding: "26px 16px", borderRadius: 12, background: "#F4F5F7", fontWeight: 600, color: MUT, lineHeight: 1.5 }}>😌 {homeGoals}–{awayGoals} — a goalless classic.<br />Nothing to time. Lock it in!</div>
                          ) : (
                            <>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
                                {slots.map((s) => {
                                  const team = s.side === "home" ? home : away;
                                  const c = SIDE[s.side];
                                  const idx = parseInt(s.id.slice(1), 10) + 1;
                                  const min = minutes[s.id];
                                  const active = activeGoal === s.id;
                                  const placed = min != null;
                                  return (
                                    <button key={s.id} onClick={() => (placed ? clearGoal(s.id) : setActiveGoal(s.id))} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", border: `1.5px solid ${active ? c.color : "rgba(21,22,26,.12)"}`, borderRadius: 10, padding: "7px 11px", fontSize: 13, background: active ? c.tint : "#fff" }}>
                                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: c.color, flexShrink: 0 }} />
                                      <span style={{ fontWeight: 600 }}>{team.name} #{idx}</span>
                                      <span style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 13, color: placed ? c.color : "#9b9ea6" }}>{placed ? min + "'" : "tap →"}</span>
                                    </button>
                                  );
                                })}
                              </div>
                              <div onClick={onTimeline} style={{ position: "relative", height: 70, borderRadius: 12, background: "#F4F5F7", cursor: "crosshair", overflow: "hidden", border: "1px solid rgba(21,22,26,.06)" }}>
                                <div style={{ position: "absolute", left: `${(45 / MAX_MINUTE) * 94 + 3}%`, top: 9, bottom: 9, width: 1, background: "rgba(21,22,26,.14)" }} />
                                {[45, 90].map((mk) => (
                                  <span key={mk} style={{ position: "absolute", top: 7, left: `${(mk / MAX_MINUTE) * 94 + 3}%`, transform: "translateX(-50%)", fontFamily: "'Oswald',sans-serif", fontSize: 10, fontWeight: 500, color: "rgba(21,22,26,.34)" }}>{mk}&apos;</span>
                                ))}
                                {slots
                                  .filter((s) => minutes[s.id] != null)
                                  .map((s) => {
                                    const c = SIDE[s.side];
                                    const min = minutes[s.id];
                                    const left = (min / MAX_MINUTE) * 94 + 3;
                                    return (
                                      <div
                                        key={s.id}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          clearGoal(s.id);
                                        }}
                                        title="tap to clear"
                                        style={{ position: "absolute", top: "50%", left: `${left}%`, transform: "translate(-50%,-50%)", minWidth: 32, height: 40, padding: "0 5px", borderRadius: 9, background: c.color, color: "#fff", border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 14, boxShadow: "0 3px 9px rgba(21,22,26,.22)", cursor: "pointer", animation: "gr-pop .25s ease-out" }}
                                      >
                                        {min}
                                      </div>
                                    );
                                  })}
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 600, color: "#9b9ea6", marginTop: 6, padding: "0 2px" }}>
                                <span>KICKOFF</span>
                                <span>FULL TIME</span>
                              </div>
                            </>
                          )}
                        </>
                      )}

                      <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid rgba(21,22,26,.08)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#F4F5F7", borderRadius: 10, padding: "12px 15px", marginBottom: 14 }}>
                          <span style={{ fontFamily: "'Oswald',sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", color: "#9b9ea6" }}>Your call</span>
                          <span style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 16, letterSpacing: ".01em" }}>{winner ? `${home.name} ${homeGoals}–${awayGoals} ${away.name}` : "pick a winner"}</span>
                        </div>
                        {validateMsg && <p style={{ textAlign: "center", color: RED, fontWeight: 600, fontSize: 13, margin: "0 0 12px" }}>{validateMsg}</p>}
                        <div style={{ display: "flex", gap: 10 }}>
                          {step > 1 && (
                            <button onClick={() => goStep(step - 1)} style={{ background: "#fff", border: "1px solid rgba(21,22,26,.14)", borderRadius: 11, padding: "13px 18px", fontWeight: 600, fontSize: 14, color: "#5a5d65", cursor: "pointer" }}>← Back</button>
                          )}
                          {(() => {
                            const isStep3 = step === 3;
                            const enabled = isStep3 ? canLock : step === 1 ? winner != null : true;
                            const bg = !enabled ? "#c3c6cc" : isStep3 ? "#009E60" : RED;
                            return (
                              <button
                                onClick={() => {
                                  if (!enabled) return;
                                  if (isStep3) lockIn();
                                  else goStep(step + 1);
                                }}
                                style={{ flex: 1, border: "none", borderRadius: 11, padding: 14, fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 15, letterSpacing: ".04em", textTransform: "uppercase", color: "#fff", background: bg, cursor: enabled ? "pointer" : "not-allowed" }}
                              >
                                {isStep3 ? "🔒 LOCK IT IN" : "NEXT →"}
                              </button>
                            );
                          })()}
                        </div>
                        {step === 3 && <p style={{ textAlign: "center", fontSize: 11.5, color: "#9b9ea6", fontWeight: 600, margin: "11px 0 0" }}>⚠️ Once you lock in, your pick is final — no changes.</p>}
                      </div>
                    </>
                  )}

                  {/* ===== FINAL (open, submitted) ===== */}
                  {effectivePhase === "open" && submitted && submittedPick && (
                    <FinalTicket home={home} away={away} pick={submittedPick} />
                  )}

                  {/* ===== CLOSED / kick-off ===== */}
                  {effectivePhase === "locked" && (
                    <div style={{ textAlign: "center" }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#FCEAEB", color: "#B30510", borderRadius: 30, padding: "6px 14px", fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 12, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 6 }}>🔒 Entries closed</div>
                      <h2 style={{ ...H2, margin: "8px 0 4px" }}>It&apos;s kick-off!</h2>
                      <p style={SUB}>No more entries — the match is under way. Results land at full time.</p>
                      {submittedPick ? (
                        <div style={{ background: "#fff", border: "1px solid rgba(21,22,26,.1)", borderRadius: 14, padding: 18, textAlign: "left" }}>
                          <div style={{ fontFamily: "'Oswald',sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: ".12em", color: "#9b9ea6", textTransform: "uppercase", marginBottom: 10 }}>Your locked entry</div>
                          <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 22 }}>{home.name} {submittedPick.homeGoals}–{submittedPick.awayGoals} {away.name}</div>
                        </div>
                      ) : (
                        <div style={{ background: "#F4F5F7", borderRadius: 14, padding: 22, fontWeight: 600, color: MUT, lineHeight: 1.5 }}>👀 You&apos;re spectating — no entry locked in this time.<br />Jump in the chat and back a side →</div>
                      )}
                    </div>
                  )}

                  {/* ===== RESULT ===== */}
                  {effectivePhase === "closed" && (
                    <ResultView home={home} away={away} result={result} myScore={myScore} submittedPick={submittedPick} scoringSummary={event.scoring?.summary} />
                  )}
                </div>
              </section>
            )}

            {/* ===== CHAT COLUMN ===== */}
            {showChat && <BanterBox matchRef={matchRef} canPost={verified} playerId={playerId} height={chatHeight} />}
          </div>
        )}

        {/* ---- Rooms integration probe (kept; collapsed by default) ---- */}
        <details className="probe">
          <summary>Rooms connection — debug</summary>
          <div style={{ marginTop: 12 }}>
            <div className="kv"><span>Embedded in iframe</span><code>{String(env.inIframe)}</code></div>
            <div className="kv"><span>Parent (referrer)</span><code>{env.referrer}</code></div>
            <div className="kv"><span>Page URL</span><code className="wrap-anywhere">{env.href}</code></div>
            <div className="kv"><span>Resolved ref</span><code>{matchRef}</code></div>
            <h3 className="probe-sub">Session token</h3>
            <div className="kv"><span>Token</span><code>{tokenHint}</code></div>
            <div className="kv"><span>Verified</span><code>{String(verified)}</code></div>
            <h3 className="probe-sub">Player (verified claims)</h3>
            <div className="kv"><span>displayName</span><code>{player?.displayName ?? (devName ? `${devName} (stub)` : "— none —")}</code></div>
            <div className="kv"><span>playerId</span><code>{player?.playerId ?? "— none —"}</code></div>
            <div className="kv"><span>returnUrl</span><code className="wrap-anywhere">{returnUrl ?? "— none —"}</code></div>
            <h3 className="probe-sub">Query params ({Object.keys(env.query).length})</h3>
            {Object.keys(env.query).length === 0 ? <p className="muted-line">none</p> : Object.entries(env.query).map(([k, v]) => <div className="kv" key={k}><span>{k}</span><code className="wrap-anywhere">{v}</code></div>)}
            <h3 className="probe-sub">Last message sent to host</h3>
            <pre className="log">{lastSent ? JSON.stringify(lastSent, null, 2) : "— nothing sent yet —"}</pre>
            <h3 className="probe-sub">Messages received from host ({hostMsgs.length})</h3>
            {hostMsgs.length === 0 ? <p className="muted-line">none yet — host messages will appear here live.</p> : <pre className="log">{hostMsgs.map((m) => `[${m.t}] from ${m.origin}\n${safeJson(m.data)}`).join("\n\n")}</pre>}
          </div>
        </details>
      </div>
    </div>
  );
}

function Crest({ side, code }: { side: "home" | "away"; code: string }) {
  const c = SIDE[side];
  return (
    <div style={{ width: 46, height: 46, borderRadius: 11, background: c.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#fff", fontFamily: "'Oswald',sans-serif", letterSpacing: ".02em", flexShrink: 0 }}>{code}</div>
  );
}

function ScoreRow({ side, team, goals, onMinus, onPlus }: { side: "home" | "away"; team: Team; goals: number; onMinus: () => void; onPlus: () => void }) {
  const c = SIDE[side];
  const btn: React.CSSProperties = { width: 40, height: 40, borderRadius: 11, border: `1px solid ${LINE}`, background: "#fff", color: INK, fontSize: 22, fontWeight: 600, lineHeight: 1, cursor: "pointer" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, borderRadius: 12, background: c.tint }}>
      <div style={{ width: 42, height: 42, borderRadius: 10, background: c.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#fff", fontFamily: "'Oswald',sans-serif" }}>{team.code}</div>
      <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 16, flex: 1, textTransform: "uppercase", letterSpacing: ".01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onMinus} style={btn}>−</button>
        <span style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 700, fontSize: 30, minWidth: 24, textAlign: "center" }}>{goals}</span>
        <button onClick={onPlus} style={btn}>+</button>
      </div>
    </div>
  );
}

function OutcomePill({ home, away, h, a }: { home: Team; away: Team; h: number; a: number }) {
  const o = outcomeOf(h, a);
  const map: Record<Outcome, [string, string, string]> = {
    HOME: [`${home.name} win`, SIDE.home.color, SIDE.home.tint],
    AWAY: [`${away.name} win`, SIDE.away.color, SIDE.away.tint],
    DRAW: ["Dead heat — a draw", SIDE.draw.color, SIDE.draw.tint],
  };
  const [label, color, tint] = map[o];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, background: tint, color, borderRadius: 30, padding: "8px 18px", fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 15, letterSpacing: ".02em", textTransform: "uppercase" }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

function FinalTicket({ home, away, pick }: { home: Team; away: Team; pick: Pick }) {
  const mins = [...pick.homeGoalMinutes, ...pick.awayGoalMinutes].sort((a, b) => a - b);
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#E6F6EF", color: "#008A54", borderRadius: 30, padding: "6px 14px", fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 12, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 14 }}>✓ Locked in &amp; final</div>
      <div style={{ background: "linear-gradient(135deg,#E20613,#15161A)", borderRadius: 14, padding: 22, boxShadow: "0 14px 34px rgba(226,6,19,.26)" }}>
        <div style={{ fontFamily: "'Oswald',sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: ".16em", color: "rgba(255,255,255,.72)", textTransform: "uppercase", marginBottom: 14 }}>⭐ Your prediction</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, color: "#fff" }}>
          <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 800, fontSize: 20 }}>{home.code}</div></div>
          <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 700, fontSize: 46, letterSpacing: ".02em" }}>{pick.homeGoals}–{pick.awayGoals}</div>
          <div style={{ textAlign: "center" }}><div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 800, fontSize: 20 }}>{away.code}</div></div>
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          {mins.length === 0 ? (
            <span style={{ color: "rgba(255,255,255,.7)", fontWeight: 600, fontSize: 13 }}>a clean-sheet derby</span>
          ) : (
            mins.map((m, i) => <span key={i} style={{ background: "rgba(255,255,255,.16)", color: "#fff", borderRadius: 20, padding: "3px 11px", fontFamily: "'Oswald',sans-serif", fontWeight: 500, fontSize: 12, letterSpacing: ".02em" }}>{m}&apos;</span>)
          )}
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: "#9b9ea6", fontWeight: 600, margin: "14px 0 0" }}>🏁 Results unlock at full time. Keep the banter going →</p>
    </div>
  );
}

function ResultView({ home, away, result, myScore, submittedPick, scoringSummary }: { home: Team; away: Team; result: ResultDef | null; myScore: ScoreBreakdown | null; submittedPick: Pick | null; scoringSummary?: string }) {
  if (!result) {
    return <div style={{ textAlign: "center", padding: "26px 16px", borderRadius: 12, background: "#F4F5F7", fontWeight: 600, color: MUT, lineHeight: 1.5 }}>🏁 Full time — awaiting the official result.</div>;
  }
  const goals = [
    ...result.homeGoalMinutes.map((m) => ({ side: "home" as const, min: m })),
    ...result.awayGoalMinutes.map((m) => ({ side: "away" as const, min: m })),
  ].sort((a, b) => a.min - b.min);
  const outLabel = result.outcome === "HOME" ? `${home.name} win` : result.outcome === "AWAY" ? `${away.name} win` : "Draw";

  const chips: { label: string; bg: string; col: string }[] = [];
  if (myScore) {
    const d = myScore.detail;
    chips.push(d.outcome.correct ? { label: "✓ result", bg: "#E6F6EF", col: "#008A54" } : { label: "✗ missed", bg: "#F4F5F7", col: "#9b9ea6" });
    if (d.score.exact) chips.push({ label: "🎯 exact", bg: "#FCEAEB", col: RED });
    else if (d.timing.comparable && d.bands.timing > 0) chips.push({ label: `⏱ ${d.bands.timing}`, bg: "#F4F5F7", col: MUT });
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: RED }} />
        <span style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: RED }}>Full time · Final result</span>
      </div>
      <div style={{ background: INK, borderRadius: 14, padding: 18, color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18 }}>
          <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 800, fontSize: 20 }}>{home.code}</div>
          <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 700, fontSize: 44, letterSpacing: ".02em", whiteSpace: "nowrap" }}>{result.homeGoals} – {result.awayGoals}</div>
          <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 800, fontSize: 20 }}>{away.code}</div>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          {goals.map((g, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,.14)", color: "#fff", borderRadius: 20, padding: "3px 11px", fontFamily: "'Oswald',sans-serif", fontWeight: 500, fontSize: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: SIDE[g.side].color }} />
              {g.min}&apos;
            </span>
          ))}
        </div>
        <div style={{ textAlign: "center", marginTop: 11, fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 13, letterSpacing: ".06em", textTransform: "uppercase", color: "#FF7A85" }}>{outLabel}</div>
      </div>

      {/* your result */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 13, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 9 }}>Your result</div>
        {submittedPick && myScore ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderRadius: 11, background: "#FFF7F7", border: `1.5px solid ${RED}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 14 }}>{home.name} {submittedPick.homeGoals}–{submittedPick.awayGoals} {away.name}</div>
              <div style={{ fontSize: 11.5, color: MUT, fontWeight: 600, marginTop: 1 }}>{[...submittedPick.homeGoalMinutes, ...submittedPick.awayGoalMinutes].sort((a, b) => a - b).map((m) => m + "'").join(" ") || "no goals"}</div>
            </div>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {chips.map((c, i) => (
                <span key={i} style={{ fontFamily: "'Oswald',sans-serif", fontSize: 10, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", background: c.bg, color: c.col, borderRadius: 20, padding: "3px 8px" }}>{c.label}</span>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ background: "#F4F5F7", borderRadius: 11, padding: "11px 14px", fontWeight: 600, fontSize: 13, color: MUT }}>You didn&apos;t lock in an entry this match.</div>
        )}
        <p style={{ fontSize: 11, color: "#9b9ea6", fontWeight: 600, lineHeight: 1.5, margin: "12px 0 0" }}>
          {scoringSummary || "Closest call wins: right result first, then closest scoreline, then closest goal minutes."} The full room standings are tallied and audited by Rooms.
        </p>
      </div>
    </div>
  );
}

const H2: React.CSSProperties = { fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 22, textTransform: "uppercase", letterSpacing: ".01em", margin: "0 0 4px" };
const SUB: React.CSSProperties = { fontSize: 13.5, color: MUT, fontWeight: 500, margin: "0 0 18px" };

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
