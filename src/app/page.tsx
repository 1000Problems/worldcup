"use client";

import { useEffect, useMemo, useState } from "react";

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
  const ref = useMemo(() => {
    if (typeof window === "undefined") return "match-38";
    return new URLSearchParams(window.location.search).get("ref") ?? "match-38";
  }, []);

  const [event, setEvent] = useState<EventData | null>(null);
  const [phase, setPhase] = useState<Phase>("open");
  const [selected, setSelected] = useState<OutcomeId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`/event/${ref}`).then((r) => r.json()),
      fetch(`/phase/${ref}`).then((r) => r.json()),
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
  }, [ref]);

  const countdown = useCountdown(event?.expectedLockAt);
  const locked = phase !== "open";

  async function choose(id: OutcomeId) {
    if (locked) return;
    setSelected(id);
    // Hand the pick to the Rooms host (which owns the pick store) via the
    // sandboxed-iframe channel. Rooms validates and freezes it at lock.
    if (typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({ type: "rooms:pick", ref, pick: id }, "*");
    }
  }

  if (error) {
    return (
      <main className="wrap">
        <p className="status">{error}</p>
      </main>
    );
  }

  if (!event) {
    return (
      <main className="wrap">
        <p className="status">Loading…</p>
      </main>
    );
  }

  const { labels, options } = event;

  return (
    <main className="wrap">
      <p className="kicker">
        {labels.competition} · {labels.stage}
      </p>

      <div className="match">
        <div className="team">
          <div className="crest esp">{labels.home.code}</div>
          <div className="team-name">{labels.home.name}</div>
        </div>
        <div className="vs">VS</div>
        <div className="team">
          <div className="crest ksa">{labels.away.code}</div>
          <div className="team-name">{labels.away.name}</div>
        </div>
      </div>

      <p className="meta">{labels.venue}</p>
      <p className="countdown">{phase === "closed" ? "Full time" : countdown}</p>

      <p className="q">Who wins?</p>

      <div className="options">
        {options.map((o) => {
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

      <p className="footer">
        Higher reward for the bolder call — a Saudi Arabia upset pays most.
        <br />A 1000Problems room for the Rooms platform.
      </p>
    </main>
  );
}
