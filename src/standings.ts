import { orderTiedGroup } from "./tiebreak.js";
import type { PlayedMatch, PointsConfig, StandingEntry, TeamId, TeamStats } from "./types.js";

/**
 * Total ordering of all teams: league points descending; each tied group is
 * resolved by the recursive head-to-head rules in `orderTiedGroup`.
 */
export function orderTeams(
  stats: ReadonlyMap<TeamId, TeamStats>,
  matches: readonly PlayedMatch[],
  cfg: PointsConfig,
): TeamId[] {
  const byPoints = new Map<number, TeamId[]>();
  for (const [team, s] of stats) {
    const group = byPoints.get(s.points);
    if (group) group.push(team);
    else byPoints.set(s.points, [team]);
  }
  const ordered: TeamId[] = [];
  for (const [, group] of [...byPoints.entries()].sort((a, b) => b[0] - a[0])) {
    ordered.push(...orderTiedGroup(group, matches, cfg));
  }
  return ordered;
}

export function buildStandings(
  stats: ReadonlyMap<TeamId, TeamStats>,
  matches: readonly PlayedMatch[],
  cfg: PointsConfig,
): StandingEntry[] {
  return orderTeams(stats, matches, cfg).map((team, index) => ({
    ...stats.get(team)!,
    rank: index + 1,
  }));
}
