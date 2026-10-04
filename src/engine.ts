import { buildStandings } from "./standings.js";
import {
  DEFAULT_POINTS,
  type MatchEvent,
  type PlayedMatch,
  type PointsConfig,
  type StandingEntry,
  type TeamId,
  type TeamStats,
} from "./types.js";

export interface MutationResult {
  /** Teams whose stat lines were recomputed by this mutation. */
  affected: TeamId[];
}

interface RecomputedState {
  matches: Map<string, PlayedMatch>;
  stats: Map<TeamId, TeamStats>;
  standings: StandingEntry[];
}

function emptyStats(team: TeamId): TeamStats {
  return {
    team,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    scored: 0,
    conceded: 0,
    diff: 0,
    points: 0,
  };
}

function validateScore(score: number, label: string): void {
  if (!Number.isInteger(score) || score < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${score}`);
  }
}

/**
 * Event-sourced ranking engine.
 *
 * The append-only event log is the source of truth. Mutations
 * (result / cancel / correct) adjust only the two affected teams' cached
 * aggregates via deltas, so standings are re-derived from cached aggregates
 * without rescanning history. `verifyAgainstFullRecompute` replays the whole
 * log through an independent code path and checks both agree.
 */
export class RankingEngine {
  private readonly cfg: PointsConfig;
  private readonly events: MatchEvent[] = [];
  private readonly matches = new Map<string, PlayedMatch>();
  private readonly stats = new Map<TeamId, TeamStats>();

  constructor(cfg: PointsConfig = DEFAULT_POINTS) {
    this.cfg = cfg;
  }

  recordResult(
    matchId: string,
    home: TeamId,
    away: TeamId,
    homeScore: number,
    awayScore: number,
  ): MutationResult {
    if (this.matches.has(matchId)) {
      throw new Error(`match ${matchId} already has a result; use correctResult`);
    }
    this.validateMatch(matchId, home, away, homeScore, awayScore);
    const match: PlayedMatch = { matchId, home, away, homeScore, awayScore };
    this.events.push({ kind: "result", matchId, home, away, homeScore, awayScore });
    this.matches.set(matchId, match);
    this.applyDelta(match, +1);
    return { affected: [home, away] };
  }

  cancelMatch(matchId: string): MutationResult {
    const match = this.matches.get(matchId);
    if (!match) throw new Error(`cannot cancel unknown match ${matchId}`);
    this.events.push({ kind: "cancel", matchId });
    this.matches.delete(matchId);
    this.applyDelta(match, -1);
    return { affected: [match.home, match.away] };
  }

  correctResult(matchId: string, homeScore: number, awayScore: number): MutationResult {
    const match = this.matches.get(matchId);
    if (!match) throw new Error(`cannot correct unknown match ${matchId}`);
    validateScore(homeScore, "homeScore");
    validateScore(awayScore, "awayScore");
    this.events.push({ kind: "correct", matchId, homeScore, awayScore });
    this.applyDelta(match, -1);
    match.homeScore = homeScore;
    match.awayScore = awayScore;
    this.applyDelta(match, +1);
    return { affected: [match.home, match.away] };
  }

  getStandings(): StandingEntry[] {
    return buildStandings(this.stats, [...this.matches.values()], this.cfg);
  }

  getEvents(): readonly MatchEvent[] {
    return this.events;
  }

  /**
   * Replays the entire event log from scratch through an independent code
   * path (fold the log into the valid match set, then sum each team's stats
   * match by match) and checks it agrees with the incrementally maintained
   * state. Returns true when both agree.
   */
  verifyAgainstFullRecompute(): boolean {
    const full = RankingEngine.fullRecompute(this.events, this.cfg);
    if (!sameMatches(this.matches, full.matches)) return false;
    if (!sameStats(this.stats, full.stats)) return false;
    return sameStandings(this.getStandings(), full.standings);
  }

  /** Independent from-scratch replay of an event log. */
  static fullRecompute(events: readonly MatchEvent[], cfg: PointsConfig = DEFAULT_POINTS): RecomputedState {
    const matches = new Map<string, PlayedMatch>();
    for (const event of events) {
      switch (event.kind) {
        case "result":
          matches.set(event.matchId, {
            matchId: event.matchId,
            home: event.home,
            away: event.away,
            homeScore: event.homeScore,
            awayScore: event.awayScore,
          });
          break;
        case "cancel":
          matches.delete(event.matchId);
          break;
        case "correct": {
          const match = matches.get(event.matchId);
          if (!match) throw new Error(`cannot correct unknown match ${event.matchId}`);
          matches.set(event.matchId, { ...match, homeScore: event.homeScore, awayScore: event.awayScore });
          break;
        }
      }
    }

    const stats = new Map<TeamId, TeamStats>();
    for (const match of matches.values()) {
      accumulate(stats, match, cfg);
    }
    const standings = buildStandings(stats, [...matches.values()], cfg);
    return { matches, stats, standings };
  }

  private validateMatch(
    matchId: string,
    home: TeamId,
    away: TeamId,
    homeScore: number,
    awayScore: number,
  ): void {
    if (!matchId) throw new Error("matchId must be non-empty");
    if (home === away) throw new Error(`teams must differ, got ${home} vs ${away}`);
    validateScore(homeScore, "homeScore");
    validateScore(awayScore, "awayScore");
  }

  private applyDelta(match: PlayedMatch, sign: 1 | -1): void {
    const home = this.statsFor(match.home);
    const away = this.statsFor(match.away);
    home.played += sign;
    away.played += sign;
    home.scored += sign * match.homeScore;
    home.conceded += sign * match.awayScore;
    away.scored += sign * match.awayScore;
    away.conceded += sign * match.homeScore;
    home.diff = home.scored - home.conceded;
    away.diff = away.scored - away.conceded;
    if (match.homeScore > match.awayScore) {
      home.won += sign;
      away.lost += sign;
      home.points += sign * this.cfg.win;
      away.points += sign * this.cfg.loss;
    } else if (match.homeScore < match.awayScore) {
      away.won += sign;
      home.lost += sign;
      away.points += sign * this.cfg.win;
      home.points += sign * this.cfg.loss;
    } else {
      home.drawn += sign;
      away.drawn += sign;
      home.points += sign * this.cfg.draw;
      away.points += sign * this.cfg.draw;
    }
    // A team with no valid matches left drops out of the standings, matching
    // the full-recompute semantics.
    if (home.played === 0) this.stats.delete(home.team);
    if (away.played === 0) this.stats.delete(away.team);
  }

  private statsFor(team: TeamId): TeamStats {
    let stats = this.stats.get(team);
    if (!stats) {
      stats = emptyStats(team);
      this.stats.set(team, stats);
    }
    return stats;
  }
}

/** Full-recompute counterpart of the incremental delta: plain accumulation. */
function accumulate(stats: Map<TeamId, TeamStats>, match: PlayedMatch, cfg: PointsConfig): void {
  for (const side of ["home", "away"] as const) {
    const team = match[side];
    let entry = stats.get(team);
    if (!entry) {
      entry = emptyStats(team);
      stats.set(team, entry);
    }
    const scored = side === "home" ? match.homeScore : match.awayScore;
    const conceded = side === "home" ? match.awayScore : match.homeScore;
    entry.played += 1;
    entry.scored += scored;
    entry.conceded += conceded;
    entry.diff = entry.scored - entry.conceded;
    if (scored > conceded) {
      entry.won += 1;
      entry.points += cfg.win;
    } else if (scored < conceded) {
      entry.lost += 1;
      entry.points += cfg.loss;
    } else {
      entry.drawn += 1;
      entry.points += cfg.draw;
    }
  }
}

function sameMatches(a: ReadonlyMap<string, PlayedMatch>, b: ReadonlyMap<string, PlayedMatch>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, matchA] of a) {
    const matchB = b.get(id);
    if (!matchB) return false;
    if (
      matchA.home !== matchB.home ||
      matchA.away !== matchB.away ||
      matchA.homeScore !== matchB.homeScore ||
      matchA.awayScore !== matchB.awayScore
    ) {
      return false;
    }
  }
  return true;
}

function sameStats(a: ReadonlyMap<TeamId, TeamStats>, b: ReadonlyMap<TeamId, TeamStats>): boolean {
  if (a.size !== b.size) return false;
  for (const [team, statsA] of a) {
    const statsB = b.get(team);
    if (!statsB) return false;
    if (
      statsA.played !== statsB.played ||
      statsA.won !== statsB.won ||
      statsA.drawn !== statsB.drawn ||
      statsA.lost !== statsB.lost ||
      statsA.scored !== statsB.scored ||
      statsA.conceded !== statsB.conceded ||
      statsA.diff !== statsB.diff ||
      statsA.points !== statsB.points
    ) {
      return false;
    }
  }
  return true;
}

function sameStandings(a: readonly StandingEntry[], b: readonly StandingEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return entry.rank === other.rank && entry.team === other.team && entry.points === other.points;
  });
}
