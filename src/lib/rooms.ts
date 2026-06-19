// ---------------------------------------------------------------------------
// World Cup Match Predictor — core game logic for the Rooms contract.
//
// Players predict a full scoreline plus the minute of every goal. Ranking is a
// three-tier cascade, encoded into Rooms' single `points` scalar via
// magnitude-separated bands so a lower tier can never overflow a higher one:
//
//   1. outcome   — right winner/draw beats wrong, always          (W_OUTCOME)
//   2. score     — closeness of the scoreline; exact tops the tier (0..9999)
//   3. timing    — closeness of the goal minutes                  (0..99)
//
// Rooms re-runs /score to audit the board, so scorePicks() must stay pure.
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";

export type Outcome = "HOME" | "DRAW" | "AWAY";

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

// --- Event registry --------------------------------------------------------
// One deployed service answers for every fixture; the match is selected by ref.

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

// v1: one deployment serves one room/one match. Routing roomId→ref is a later
// step (ARCHITECTURE.md); until then the sole configured match answers.
export const DEFAULT_REF = "match-38";

export function getMatch(ref: string): MatchDef | null {
  return MATCHES[ref] ?? null;
}

export function outcomeOf(homeGoals: number, awayGoals: number): Outcome {
  return homeGoals > awayGoals ? "HOME" : homeGoals < awayGoals ? "AWAY" : "DRAW";
}

// --- Pick & result shapes --------------------------------------------------

export interface Pick {
  homeGoals: number; // 0..MAX_GOALS
  awayGoals: number;
  homeGoalMinutes: number[]; // length === homeGoals, each 1..MAX_MINUTE
  awayGoalMinutes: number[]; // length === awayGoals
}

export interface PlayerPick {
  playerId: string;
  pick: Pick;
}

export interface ResultDef {
  ref: string;
  homeGoals: number;
  awayGoals: number;
  outcome: Outcome;
  homeGoalMinutes: number[];
  awayGoalMinutes: number[];
  final: true;
}

export interface ScoreBreakdown {
  playerId: string;
  points: number;
  detail: {
    outcome: { picked: Outcome; actual: Outcome; correct: boolean };
    score: { picked: string; actual: string; exact: boolean; gdMatch: boolean; totalMatch: boolean };
    timing: { comparable: boolean; error: number };
    bands: { outcome: number; score: number; timing: number };
  };
}

// --- Scoring constants (all live here; the scorer is pure) ------------------

export const MAX_GOALS = 20;
export const MAX_MINUTE = 120;

const W_OUTCOME = 1_000_000; // tier 1 dominates everything below
const SCORE_CAP = 9_999; // tier 2 ceiling
const TIMING_CAP = 99; // tier 3 ceiling

// --- Validation (pure) -----------------------------------------------------

export function validatePick(_m: MatchDef, pick: unknown): { valid: boolean; reason?: string } {
  if (!pick || typeof pick !== "object") return { valid: false, reason: "pick must be an object" };
  const p = pick as Record<string, unknown>;
  const { homeGoals, awayGoals, homeGoalMinutes, awayGoalMinutes } = p;

  for (const [label, g] of [["homeGoals", homeGoals], ["awayGoals", awayGoals]] as const) {
    if (!Number.isInteger(g) || (g as number) < 0 || (g as number) > MAX_GOALS) {
      return { valid: false, reason: `${label} must be an integer 0..${MAX_GOALS}` };
    }
  }
  const checks: [string, unknown, number][] = [
    ["homeGoalMinutes", homeGoalMinutes, homeGoals as number],
    ["awayGoalMinutes", awayGoalMinutes, awayGoals as number],
  ];
  for (const [label, mins, count] of checks) {
    if (!Array.isArray(mins)) return { valid: false, reason: `${label} must be an array` };
    if (mins.length !== count) {
      return { valid: false, reason: `${label} must have exactly ${count} entr${count === 1 ? "y" : "ies"}` };
    }
    for (const mm of mins) {
      if (!Number.isInteger(mm) || (mm as number) < 1 || (mm as number) > MAX_MINUTE) {
        return { valid: false, reason: `${label} entries must be integers 1..${MAX_MINUTE}` };
      }
    }
  }
  return { valid: true };
}

// --- Pure cascade scorer ---------------------------------------------------

export function scorePicks(result: ResultDef, picks: PlayerPick[]): ScoreBreakdown[] {
  return picks.map(({ playerId, pick }) => {
    // Tier 1 — outcome
    const picked = outcomeOf(pick.homeGoals, pick.awayGoals);
    const correct = picked === result.outcome;
    const outcomeBand = correct ? W_OUTCOME : 0;

    // Tier 2 — score accuracy
    const homeErr = Math.abs(pick.homeGoals - result.homeGoals);
    const awayErr = Math.abs(pick.awayGoals - result.awayGoals);
    const exact = homeErr === 0 && awayErr === 0;
    const gdMatch = pick.homeGoals - pick.awayGoals === result.homeGoals - result.awayGoals;
    const totalMatch = pick.homeGoals + pick.awayGoals === result.homeGoals + result.awayGoals;
    const scoreBand = Math.min(
      SCORE_CAP,
      (exact ? 4000 : 0) +
        (gdMatch ? 2000 : 0) +
        (totalMatch ? 1000 : 0) +
        Math.max(0, 2000 - 250 * (homeErr + awayErr)),
    );

    // Tier 3 — goal-minute closeness (only when goal counts match reality)
    const predMin = [...pick.homeGoalMinutes, ...pick.awayGoalMinutes].sort((a, b) => a - b);
    const actMin = [...result.homeGoalMinutes, ...result.awayGoalMinutes].sort((a, b) => a - b);
    const comparable = predMin.length === actMin.length;
    let timingError = 0;
    if (comparable) {
      for (let i = 0; i < predMin.length; i++) timingError += Math.abs(predMin[i] - actMin[i]);
    }
    const timingBand = comparable ? Math.max(0, TIMING_CAP - timingError) : 0;

    return {
      playerId,
      points: outcomeBand + scoreBand + timingBand,
      detail: {
        outcome: { picked, actual: result.outcome, correct },
        score: {
          picked: `${pick.homeGoals}-${pick.awayGoals}`,
          actual: `${result.homeGoals}-${result.awayGoals}`,
          exact,
          gdMatch,
          totalMatch,
        },
        timing: { comparable, error: comparable ? timingError : -1 },
        bands: { outcome: outcomeBand, score: scoreBand, timing: timingBand },
      },
    };
  });
}

// --- Pick store (ROOM-OWNED, private) ---------------------------------------
// This room owns its picks. Rooms (the host) NEVER sees what a player predicted
// — it only receives resolved results (placement + rewards) at /close. Picks are
// captured server-side at lock-in (POST /pick, verified via the Rooms session
// cookie so each pick is tied to a real Rooms identity) and scored locally by the
// pure scorer. In-memory like the result store; swap for Neon/Vercel KV for
// production durability.

// Launch context, harvested from the verified session at pick time: who the room
// is in Rooms (roomId) and where to POST results. The Rooms host is INFERRED from
// the token's returnUrl origin — true today, not a value Rooms hands us explicitly.
export type LaunchCtx = { roomId: string; roomsHost: string };

export function recordPick(ref: string, playerId: string, pick: Pick, ctx?: LaunchCtx): Promise<void> {
  return store.savePick(ref, playerId, pick, ctx); // last write wins; finality enforced in /pick
}

export function listPicks(ref: string): Promise<PlayerPick[]> {
  return store.loadPicks(ref);
}

export function launchCtx(ref: string): Promise<LaunchCtx | null> {
  return store.loadCtx(ref);
}

// --- Result store ----------------------------------------------------------

export function getResult(ref: string): Promise<ResultDef | null> {
  return store.loadResult(ref);
}

export async function setResult(
  ref: string,
  homeGoals: number,
  awayGoals: number,
  homeGoalMinutes: number[],
  awayGoalMinutes: number[],
): Promise<ResultDef> {
  const result: ResultDef = {
    ref,
    homeGoals,
    awayGoals,
    outcome: outcomeOf(homeGoals, awayGoals),
    homeGoalMinutes,
    awayGoalMinutes,
    final: true,
  };
  await store.saveResult(result);
  return result;
}

// --- Manual lifecycle override (dev/test) ----------------------------------
// Lets the /dev controls drive open → locked → closed → open on demand without
// waiting for the real kickoff. In-memory: a cold start clears overrides, which is
// fine for a test tool — the real lock is the clock vs kickoff, which is durable.

const manualLocks = new Set<string>();

export function setLock(ref: string) {
  manualLocks.add(ref);
}
export function clearLock(ref: string) {
  manualLocks.delete(ref);
}
export function isLocked(ref: string) {
  return manualLocks.has(ref);
}

// Wipe OUR durable state for a ref (picks + result) plus the in-memory lock.
export async function reset(ref: string) {
  manualLocks.delete(ref);
  await store.clear(ref);
}

// --- Phase (clock-aware; /phase may read the clock, /score may not) ---------

export type Phase = "open" | "locked" | "closed";

export async function phaseFor(m: MatchDef, now: Date = new Date()): Promise<Phase> {
  if (await getResult(m.ref)) return "closed";
  if (manualLocks.has(m.ref) || now.getTime() >= new Date(m.kickoffISO).getTime()) return "locked";
  return "open";
}
