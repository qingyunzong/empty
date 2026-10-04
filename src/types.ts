export type TeamId = string;

/** A match with a confirmed, currently valid result. */
export interface PlayedMatch {
  matchId: string;
  home: TeamId;
  away: TeamId;
  homeScore: number;
  awayScore: number;
}

/** Append-only event log entries. The log is the source of truth. */
export type MatchEvent =
  | { kind: "result"; matchId: string; home: TeamId; away: TeamId; homeScore: number; awayScore: number }
  | { kind: "cancel"; matchId: string }
  | { kind: "correct"; matchId: string; homeScore: number; awayScore: number };

/** Points awarded for win / draw / loss. */
export interface PointsConfig {
  win: number;
  draw: number;
  loss: number;
}

export const DEFAULT_POINTS: PointsConfig = { win: 3, draw: 1, loss: 0 };

export interface TeamStats {
  team: TeamId;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  scored: number;
  conceded: number;
  diff: number;
  points: number;
}

export interface StandingEntry extends TeamStats {
  rank: number;
}
