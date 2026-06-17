// ---------------------------------------------------------------------------
// World Cup Match Predictor — core game logic for the Rooms contract.
//
// The platform (Rooms) owns identity, the pick store, lock enforcement, and the
// audited scoreboard. This module is the seam: it defines the events, validates
// picks, signals phase, holds the resolved result, and scores — purely.
// ---------------------------------------------------------------------------

export type OutcomeId = "ESP" | "DRAW" | "KSA";

export interface Team {
  code: string; // FIFA tricode
  name: string;
}

export interface MatchDef {
  ref: string;
  competition: string;
  stage: string;
  home: Team;
  away: Team;
  venue: string;
  kickoffISO: string; // UTC kickoff; lock fires here
}

export interface Option {
  id: OutcomeId;
  label: string;
  points: number; // points a correct call of this outcome is worth (pure, constant)
}

// --- Event registry --------------------------------------------------------
// One deployed service answers for every fixture; the match is selected by ref.
// Seeded with match-38. Adding the rest of the tournament is data, not code.

const MATCHES: Record<string, MatchDef> = {
  "match-38": {
    ref: "match-38",
    competition: "FIFA World Cup 2026",
    stage: "Group H · Matchday 2",
    home: { code: "ESP", name: "Spain" },
    away: { code: "KSA", name: "Saudi Arabia" },
    venue: "Mercedes-Benz Stadium, Atlanta",
    // 12:00 ET on 21 Jun 2026. June is EDT (UTC-4) → 16:00 UTC.
    kickoffISO: "2026-06-21T16:00:00.000Z",
  },
};

// Outcome options for a single match. Points reward difficulty: backing the
// favourite (Spain) is worth less than calling a draw or a Saudi upset.
export function optionsFor(m: MatchDef): Option[] {
  return [
    { id: "ESP", label: `${m.home.name} win`, points: 2 },
    { id: "DRAW", label: "Draw", points: 3 },
    { id: "KSA", label: `${m.away.name} win`, points: 5 },
  ];
}

export function getMatch(ref: string): MatchDef | null {
  return MATCHES[ref] ?? null;
}

// --- Result store ----------------------------------------------------------
// Resolution is manual for now (admin POST). In-memory is fine: Rooms owns the
// durable pick store and re-runs the pure scorer. A cold start just clears the
// posted result, which the admin re-posts. Swap for Neon/KV in production.

export interface ResultDef {
  ref: string;
  outcome: OutcomeId;
  homeGoals: number;
  awayGoals: number;
  final: true;
}

const results = new Map<string, ResultDef>();

export function getResult(ref: string): ResultDef | null {
  return results.get(ref) ?? null;
}

export function setResult(ref: string, homeGoals: number, awayGoals: number): ResultDef {
  const outcome: OutcomeId =
    homeGoals > awayGoals ? "ESP" : homeGoals < awayGoals ? "KSA" : "DRAW";
  const result: ResultDef = { ref, outcome, homeGoals, awayGoals, final: true };
  results.set(ref, result);
  return result;
}

// --- Pure scoring ----------------------------------------------------------
// (picks, result) → points. No IO, no clock, no randomness — Rooms re-runs this
// to audit the board, so identical inputs must always yield identical outputs.

export interface Pick {
  playerId: string;
  pick: OutcomeId;
}

export interface ScoreBreakdown {
  playerId: string;
  points: number;
  detail: { picked: OutcomeId; actual: OutcomeId; hit: boolean };
}

export function pointsForOutcome(outcome: OutcomeId): number {
  switch (outcome) {
    case "ESP":
      return 2;
    case "DRAW":
      return 3;
    case "KSA":
      return 5;
  }
}

export function scorePicks(result: ResultDef, picks: Pick[]): ScoreBreakdown[] {
  return picks.map(({ playerId, pick }) => {
    const hit = pick === result.outcome;
    return {
      playerId,
      points: hit ? pointsForOutcome(result.outcome) : 0,
      detail: { picked: pick, actual: result.outcome, hit },
    };
  });
}

// --- Validation (pure) -----------------------------------------------------

export function validatePick(m: MatchDef, pick: unknown): { valid: boolean; reason?: string } {
  const ids = optionsFor(m).map((o) => o.id);
  if (typeof pick !== "string") return { valid: false, reason: "pick must be a string" };
  if (!ids.includes(pick as OutcomeId)) {
    return { valid: false, reason: `pick must be one of ${ids.join(", ")}` };
  }
  return { valid: true };
}

// --- Phase (clock-aware; this endpoint is allowed to read the clock) --------

export type Phase = "open" | "locked" | "closed";

export function phaseFor(m: MatchDef, now: Date = new Date()): Phase {
  if (getResult(m.ref)) return "closed";
  return now.getTime() >= new Date(m.kickoffISO).getTime() ? "locked" : "open";
}
