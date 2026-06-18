"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Phase = "open" | "locked" | "closed";

export default function DevControls() {
  const ref = useMemo(() => {
    if (typeof window === "undefined") return "match-38";
    return new URLSearchParams(window.location.search).get("ref") ?? "match-38";
  }, []);

  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase | "—">("—");
  const [result, setResult] = useState<unknown>(null);
  const [msg, setMsg] = useState<string>("");

  // Restore an operator token from the session (never hard-coded, never bundled).
  useEffect(() => {
    const saved = typeof window !== "undefined" ? sessionStorage.getItem("wc_admin_token") : null;
    if (saved) setToken(saved);
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined") sessionStorage.setItem("wc_admin_token", token);
  }, [token]);

  const refresh = useCallback(async () => {
    try {
      const [ph, res] = await Promise.all([
        fetch(`/phase/${ref}`).then((r) => r.json()),
        fetch(`/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref }),
        }).then((r) => r.json()),
      ]);
      setPhase(ph?.phase ?? "—");
      setResult(res ?? null);
    } catch {
      /* ignore poll errors */
    }
  }, [ref]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(path: string, body: Record<string, unknown>, label: string) {
    if (!token) {
      setMsg("Paste the admin token first.");
      return;
    }
    setMsg(`${label}…`);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setMsg("Rejected: bad or missing admin token.");
      } else if (!res.ok) {
        setMsg(`Error (${res.status}): ${data.error ?? "failed"}`);
      } else {
        setMsg(`${label} ✓ → phase: ${data.phase ?? "(see below)"}`);
      }
    } catch {
      setMsg(`${label} failed: network error.`);
    }
    refresh();
  }

  const lock = () => act("/admin/lock", { ref }, "Lock picks");
  // Canned scenario so Rooms always tests the same known winner.
  const resolve = () =>
    act("/admin/resolve", { ref, homeGoals: 1, awayGoals: 0, homeGoalMinutes: [10], awayGoalMinutes: [] }, "Resolve (Spain 1–0, 10')");
  const reset = () => act("/admin/reset", { ref }, "Reset");

  const pill = phase === "open" ? "ok" : phase === "locked" ? "warn" : phase === "closed" ? "done" : "";

  return (
    <main className="wrap">
      <p className="kicker">Dev state controls</p>
      <h1 className="dev-h">{ref}</h1>

      <div className="dev-phase">
        <span>Current phase</span>
        <span className={`pill ${pill}`}>{phase}</span>
      </div>

      <label className="dev-label">
        Admin token (ADMIN_TOKEN)
        <input
          className="dev-token"
          type="password"
          placeholder="paste here — kept in this browser only"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <div className="dev-buttons">
        <button className="dev-btn warn" onClick={lock}>
          1 · Lock picks
        </button>
        <button className="dev-btn done" onClick={resolve}>
          2 · Resolve — Spain 1–0 (goal 10′)
        </button>
        <button className="dev-btn danger" onClick={reset}>
          3 · Reset to scratch
        </button>
      </div>

      <p className="dev-msg">{msg || " "}</p>

      <p className="scoring-note" style={{ marginTop: 8 }}>
        Reset clears <strong>our</strong> result + lock only. Rooms owns the picks — those reset on the Rooms side.
      </p>

      <h3 className="probe-sub">/resolve payload (what Rooms reads)</h3>
      <pre className="log">{result ? JSON.stringify(result, null, 2) : "null — not resolved"}</pre>

      <p className="footer">
        open → (lock or kickoff) → locked → (resolve) → closed → (reset) → open
        <br />A 1000Problems room for the Rooms platform.
      </p>
    </main>
  );
}
