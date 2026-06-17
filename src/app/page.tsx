"use client";

import { useEffect, useMemo, useState } from "react";

const MAX_GOALS = 20;

interface Team {
  code: string;
  name: string;
}

interface EventData {
  ref: string;
  expectedLockAt: string;
  scoring?: { summary?: string };
  labels: {
    title: string;
    competition: string;
    stage: string;
    venue: string;
    home: Team;
    away: Team;
  };
}

type Phase = "open" | "locked" | "closed";

interface Session {
  playerId?: string;
  displayName?: string;
  avatarToken?: string;
}

interface MsgEntry {
  t: string;
  origin: string;
  data: unknown;
}

function extractSession(obj: unknown): Session {
  const out: Session = {};
  if (!obj || typeof obj !== "object") return out;
  const candidates: any[] = [
    obj,
    (obj as any).player,
    (obj as any).session,
    (obj as any).payload,
    (obj as any).user,
    (obj as any).data,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && typeof c === "object") {
      if (!out.playerId && typeof c.playerId === "string") out.playerId = c.playerId;
      if (!out.playerId && typeof c.id === "string") out.playerId = c.id;
      if (!out.displayName && typeof c.displayName === "string") out.displayName = c.displayName;
      if (!out.displayName && typeof c.name === "string") out.displayName = c.name;
      if (!out.avatarToken && typeof c.avatarToken === "string") out.avatarToken = c.avatarToken;
    }
  }
  return out;
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
  const sec = s % 60;
  return d > 0 ? `${d}d ${h}h ${m}m to kickoff` : `${h}h ${m}m ${sec}s to kickoff`;
}

function resize(arr: string[], n: number): string[] {
  const next = arr.slice(0, n);
  while (next.length < n) next.push("");
  return next;
}

export default function RoomPage() {
  const env = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: "", ref: "match-38", query: {} as Record<string, string>, referrer: "", inIframe: false };
    }
    const params = new URLSearchParams(window.location.search);
    const query: Record<string, string> = {};
    params.forEach((v, k) => (query[k] = v));
    return {
      href: window.location.href,
      ref: query.ref ?? "match-38",
      query,
      referrer: document.referrer || "(none)",
      inIframe: window.parent !== window,
    };
  }, []);

  const [event, setEvent] = useState<EventData | null>(null);
  const [phase, setPhase] = useState<Phase>("open");
  const [error, setError] = useState<string | null>(null);

  // session / host probe
  const [session, setSession] = useState<Session>(() => extractSession(env.query));
  const [messages, setMessages] = useState<MsgEntry[]>([]);
  const [lastSent, setLastSent] = useState<unknown>(null);

  // pick builder
  const [homeGoals, setHomeGoals] = useState(0);
  const [awayGoals, setAwayGoals] = useState(0);
  const [homeMinutes, setHomeMinutes] = useState<string[]>([]);
  const [awayMinutes, setAwayMinutes] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onMsg(e: MessageEvent) {
      setMessages((prev) =>
        [{ t: new Date().toLocaleTimeString(), origin: e.origin, data: e.data }, ...prev].slice(0, 40),
      );
      const found = extractSession(e.data);
      if (found.playerId || found.displayName || found.avatarToken) {
        setSession((prev) => ({ ...prev, ...found }));
      }
    }
    window.addEventListener("message", onMsg);
    if (window.parent !== window) {
      for (const type of ["rooms:ready", "ready", "rooms:hello"]) {
        try {
          window.parent.postMessage({ type, ref: env.ref }, "*");
        } catch {}
      }
    }
    return () => window.removeEventListener("message", onMsg);
  }, [env.ref]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`/event/${env.ref}`).then((r) => r.json()),
      fetch(`/phase/${env.ref}`).then((r) => r.json()),
    ])
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
  }, [env.ref]);

  const countdown = useCountdown(event?.expectedLockAt);
  const locked = phase !== "open";
  const name = session.displayName;
  const home = event?.labels.home;
  const away = event?.labels.away;

  function changeGoals(side: "home" | "away", delta: number) {
    if (locked) return;
    setSubmitted(false);
    setValidateMsg(null);
    if (side === "home") {
      const g = Math.max(0, Math.min(MAX_GOALS, homeGoals + delta));
      setHomeGoals(g);
      setHomeMinutes((prev) => resize(prev, g));
    } else {
      const g = Math.max(0, Math.min(MAX_GOALS, awayGoals + delta));
      setAwayGoals(g);
      setAwayMinutes((prev) => resize(prev, g));
    }
  }

  function setMinute(side: "home" | "away", i: number, v: string) {
    setSubmitted(false);
    setValidateMsg(null);
    const clean = v.replace(/[^0-9]/g, "").slice(0, 3);
    (side === "home" ? setHomeMinutes : setAwayMinutes)((prev) => {
      const next = [...prev];
      next[i] = clean;
      return next;
    });
  }

  const outcomeLabel =
    !home || !away
      ? ""
      : homeGoals > awayGoals
        ? `${home.name} win`
        : homeGoals < awayGoals
          ? `${away.name} win`
          : "Draw";

  function minutesComplete(mins: string[]) {
    return mins.every((s) => {
      const n = parseInt(s, 10);
      return Number.isInteger(n) && n >= 1 && n <= 120;
    });
  }
  const complete = minutesComplete(homeMinutes) && minutesComplete(awayMinutes);

  async function submit() {
    if (locked || !complete) return;
    const pick = {
      homeGoals,
      awayGoals,
      homeGoalMinutes: homeMinutes.map((s) => parseInt(s, 10)),
      awayGoalMinutes: awayMinutes.map((s) => parseInt(s, 10)),
    };
    try {
      const res = await fetch("/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: env.ref, pick }),
      }).then((r) => r.json());
      if (!res.valid) {
        setValidateMsg(res.reason ?? "Invalid pick.");
        return;
      }
    } catch {
      setValidateMsg("Could not reach the validator.");
      return;
    }
    const payload = { type: "rooms:pick", ref: env.ref, pick, playerId: session.playerId };
    setLastSent(payload);
    if (typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage(payload, "*");
    }
    setSubmitted(true);
    setValidateMsg(null);
  }

  function GoalRow({ side, team, goals, mins }: { side: "home" | "away"; team: Team; goals: number; mins: string[] }) {
    return (
      <div className="goalrow">
        <div className={`crest ${side === "home" ? "esp" : "ksa"}`}>{team.code}</div>
        <div className="goalrow-main">
          <div className="goalrow-top">
            <span className="team-name">{team.name}</span>
            <div className="stepper">
              <button className="step" disabled={locked} onClick={() => changeGoals(side, -1)} aria-label="minus">
                −
              </button>
              <span className="goalcount">{goals}</span>
              <button className="step" disabled={locked} onClick={() => changeGoals(side, +1)} aria-label="plus">
                +
              </button>
            </div>
          </div>
          {goals > 0 && (
            <div className="minutes">
              {Array.from({ length: goals }).map((_, i) => (
                <input
                  key={i}
                  className="minput"
                  inputMode="numeric"
                  placeholder={`#${i + 1}`}
                  value={mins[i] ?? ""}
                  disabled={locked}
                  onChange={(e) => setMinute(side, i, e.target.value)}
                />
              ))}
              <span className="minlabel">goal minutes</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <main className="wrap">
      <p className="hello">{name ? `Hello, ${name}` : "Hello — waiting for Rooms sign-in…"}</p>

      {error ? (
        <p className="status">{error}</p>
      ) : !event || !home || !away ? (
        <p className="status">Loading…</p>
      ) : (
        <>
          <p className="kicker">
            {event.labels.competition} · {event.labels.stage}
          </p>
          <div className="match">
            <div className="team">
              <div className="crest esp">{home.code}</div>
              <div className="team-name">{home.name}</div>
            </div>
            <div className="vs">VS</div>
            <div className="team">
              <div className="crest ksa">{away.code}</div>
              <div className="team-name">{away.name}</div>
            </div>
          </div>
          <p className="meta">{event.labels.venue}</p>
          <p className="countdown">{phase === "closed" ? "Full time" : countdown}</p>

          <p className="q">
            Predict the final score{name ? `, ${name}` : ""} — and when each goal is scored.
          </p>

          <GoalRow side="home" team={home} goals={homeGoals} mins={homeMinutes} />
          <GoalRow side="away" team={away} goals={awayGoals} mins={awayMinutes} />

          <div className="preview">
            <span className="preview-score">
              {home.name} {homeGoals} – {awayGoals} {away.name}
            </span>
            <span className="preview-outcome">{outcomeLabel}</span>
          </div>

          {!locked && (
            <button className="submit" disabled={!complete} onClick={submit}>
              {submitted ? "Pick locked in ✓ — tap to update" : "Submit prediction"}
            </button>
          )}

          <div className={`status${locked ? " locked" : ""}`}>
            {phase === "closed"
              ? "This match is resolved."
              : locked
                ? "Picks are locked — kickoff has passed."
                : validateMsg
                  ? validateMsg
                  : submitted
                    ? "Sent to the room. Change it any time before kickoff."
                    : complete
                      ? "Looks good — submit your prediction."
                      : homeGoals + awayGoals > 0
                        ? "Fill in the minute of each goal."
                        : "Set the score, then the minute of each goal."}
          </div>

          {event.scoring?.summary && <p className="scoring-note">{event.scoring.summary}</p>}
        </>
      )}

      {/* ---- Rooms integration probe ------------------------------------- */}
      <section className="probe">
        <h2 className="probe-h">Rooms connection — debug</h2>
        <div className="kv">
          <span>Embedded in iframe</span>
          <code>{String(env.inIframe)}</code>
        </div>
        <div className="kv">
          <span>Parent (referrer)</span>
          <code>{env.referrer}</code>
        </div>
        <div className="kv">
          <span>Page URL</span>
          <code className="wrap-anywhere">{env.href}</code>
        </div>
        <div className="kv">
          <span>Resolved ref</span>
          <code>{env.ref}</code>
        </div>

        <h3 className="probe-sub">Player session</h3>
        <div className="kv">
          <span>displayName</span>
          <code>{session.displayName ?? "— not received —"}</code>
        </div>
        <div className="kv">
          <span>playerId</span>
          <code>{session.playerId ?? "— not received —"}</code>
        </div>
        <div className="kv">
          <span>avatarToken</span>
          <code className="wrap-anywhere">{session.avatarToken ?? "— not received —"}</code>
        </div>

        <h3 className="probe-sub">Query params ({Object.keys(env.query).length})</h3>
        {Object.keys(env.query).length === 0 ? (
          <p className="muted-line">none</p>
        ) : (
          Object.entries(env.query).map(([k, v]) => (
            <div className="kv" key={k}>
              <span>{k}</span>
              <code className="wrap-anywhere">{v}</code>
            </div>
          ))
        )}

        <h3 className="probe-sub">Last message sent to host</h3>
        <pre className="log">{lastSent ? JSON.stringify(lastSent, null, 2) : "— nothing sent yet —"}</pre>

        <h3 className="probe-sub">Messages received from host ({messages.length})</h3>
        {messages.length === 0 ? (
          <p className="muted-line">
            none yet — if the host pushes the session via postMessage, it will appear here live.
          </p>
        ) : (
          <pre className="log">{messages.map((m) => `[${m.t}] from ${m.origin}\n${safeJson(m.data)}`).join("\n\n")}</pre>
        )}
      </section>

      <p className="footer">
        Closest call wins: right result first, then closest score, then closest goal minutes.
        <br />A 1000Problems room for the Rooms platform.
      </p>
    </main>
  );
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
