"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type OutcomeId = "ESP" | "DRAW" | "KSA";

interface EventData {
  ref: string;
  options: { id: OutcomeId; label: string; points: number }[];
  expectedLockAt: string;
  labels: {
    title: string;
    competition: string;
    stage: string;
    venue: string;
    home: { code: string; name: string };
    away: { code: string; name: string };
  };
}

type Phase = "open" | "locked" | "closed";

// A Rooms session, however it reaches us (query param or postMessage).
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

// Pull session-ish fields out of an arbitrary object, checking the shapes a
// host might plausibly use. Non-destructive: returns only what it finds.
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

export default function RoomPage() {
  // ---- environment the iframe can observe -------------------------------
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
  const [selected, setSelected] = useState<OutcomeId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- everything we learn from the Rooms host --------------------------
  const [session, setSession] = useState<Session>(() => extractSession(env.query));
  const [messages, setMessages] = useState<MsgEntry[]>([]);
  const [lastSent, setLastSent] = useState<unknown>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Listen for any postMessage from the host, log it, and harvest session fields.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onMsg(e: MessageEvent) {
      setMessages((prev) =>
        [{ t: new Date().toLocaleTimeString(), origin: e.origin, data: e.data }, ...prev].slice(0, 40),
      );
      const found = extractSession(e.data);
      if (found.playerId || found.displayName || found.avatarToken) {
        setSession((prev) => ({ ...found, ...prev, ...found }));
      }
    }
    window.addEventListener("message", onMsg);
    // Announce readiness so a host that waits for the iframe will send the session.
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

  function choose(id: OutcomeId) {
    if (locked) return;
    setSelected(id);
    const payload = { type: "rooms:pick", ref: env.ref, pick: id, playerId: session.playerId };
    setLastSent(payload);
    if (typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage(payload, "*");
    }
  }

  return (
    <main className="wrap">
      {/* greeting */}
      <p className="hello">{name ? `Hello, ${name}` : "Hello — waiting for Rooms sign-in…"}</p>

      {error ? (
        <p className="status">{error}</p>
      ) : !event ? (
        <p className="status">Loading…</p>
      ) : (
        <>
          <p className="kicker">
            {event.labels.competition} · {event.labels.stage}
          </p>
          <div className="match">
            <div className="team">
              <div className="crest esp">{event.labels.home.code}</div>
              <div className="team-name">{event.labels.home.name}</div>
            </div>
            <div className="vs">VS</div>
            <div className="team">
              <div className="crest ksa">{event.labels.away.code}</div>
              <div className="team-name">{event.labels.away.name}</div>
            </div>
          </div>
          <p className="meta">{event.labels.venue}</p>
          <p className="countdown">{phase === "closed" ? "Full time" : countdown}</p>

          <p className="q">Who wins{name ? `, ${name}` : ""}?</p>
          <div className="options">
            {event.options.map((o) => {
              const dotClass = o.id === "ESP" ? "esp" : o.id === "KSA" ? "ksa" : "draw";
              return (
                <button
                  key={o.id}
                  className={`opt${selected === o.id ? " selected" : ""}`}
                  disabled={locked}
                  onClick={() => choose(o.id)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className={`dot ${dotClass}`} />
                    {o.label}
                  </span>
                  <span className="pts">+{o.points} pts</span>
                </button>
              );
            })}
          </div>
          <div className={`status${locked ? " locked" : ""}`}>
            {phase === "closed"
              ? "This match is resolved."
              : locked
                ? "Picks are locked — kickoff has passed."
                : selected
                  ? "Pick submitted. Change it any time before kickoff."
                  : "Tap your call. You can change it until kickoff."}
          </div>
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
          <pre className="log">
            {messages
              .map((m) => `[${m.t}] from ${m.origin}\n${safeJson(m.data)}`)
              .join("\n\n")}
          </pre>
        )}
      </section>

      <p className="footer">
        Higher reward for the bolder call — a Saudi Arabia upset pays most.
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
