import type { PlayedMatch, PointsConfig, TeamId } from "./types.js";

interface MiniStats {
  points: number;
  diff: number;
}

function compareIds(a: TeamId, b: TeamId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Head-to-head ("mini-league") aggregates computed only from matches
 * where both participants belong to `ids`.
 */
function miniLeagueStats(
  ids: ReadonlySet<TeamId>,
  matches: readonly PlayedMatch[],
  cfg: PointsConfig,
): Map<TeamId, MiniStats> {
  const stats = new Map<TeamId, MiniStats>();
  for (const id of ids) stats.set(id, { points: 0, diff: 0 });
  for (const m of matches) {
    if (!ids.has(m.home) || !ids.has(m.away)) continue;
    const home = stats.get(m.home)!;
    const away = stats.get(m.away)!;
    home.diff += m.homeScore - m.awayScore;
    away.diff += m.awayScore - m.homeScore;
    if (m.homeScore > m.awayScore) {
      home.points += cfg.win;
      away.points += cfg.loss;
    } else if (m.homeScore < m.awayScore) {
      away.points += cfg.win;
      home.points += cfg.loss;
    } else {
      home.points += cfg.draw;
      away.points += cfg.draw;
    }
  }
  return stats;
}

/**
 * Split `ids` into groups sharing the same key, groups ordered by key
 * descending. Returns one group per distinct key.
 */
function splitBy(ids: readonly TeamId[], keyOf: (id: TeamId) => number): TeamId[][] {
  const groups = new Map<number, TeamId[]>();
  for (const id of ids) {
    const key = keyOf(id);
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, group]) => group);
}

/**
 * Order a group of teams that are tied on league points.
 *
 * Rules, applied recursively to any still-tied subgroup:
 *   1. head-to-head mini-league points (matches among the tied teams only)
 *   2. head-to-head mini-league point differential
 *   3. team id (ascending) — used immediately whenever a rule makes no
 *      progress (i.e. fails to split the group at all)
 */
export function orderTiedGroup(
  ids: readonly TeamId[],
  matches: readonly PlayedMatch[],
  cfg: PointsConfig,
): TeamId[] {
  if (ids.length <= 1) return [...ids];

  const idSet = new Set(ids);
  const mini = miniLeagueStats(idSet, matches, cfg);

  const byPoints = splitBy(ids, (id) => mini.get(id)!.points);
  if (byPoints.length > 1) {
    return byPoints.flatMap((group) => orderTiedGroup(group, matches, cfg));
  }

  const byDiff = splitBy(ids, (id) => mini.get(id)!.diff);
  if (byDiff.length > 1) {
    return byDiff.flatMap((group) => orderTiedGroup(group, matches, cfg));
  }

  // No progress from either rule: fall back to team id.
  return [...ids].sort(compareIds);
}
