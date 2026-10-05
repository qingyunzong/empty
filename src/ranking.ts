/**
 * 事件驱动的排名库。
 *
 * 积分：按比赛事件（录入结果 / 更正结果 / 取消场次）增量维护。
 * 名次：取消或更正后只重算受影响的名次（积分发生变化的队伍所在的积分组），
 *       并提供 fullRecompute() 完整重算用于核对。
 *
 * 同分排名规则（递归）：
 *   1. 相互战绩小联赛积分（只统计同分队伍之间的比赛）；
 *   2. 小联赛净胜分；
 *   3. 仍未分出的子组按同一规则递归（范围缩小到子组内部比赛）；
 *      若递归无任何进展（子组 == 原组），则按队伍 ID 升序。
 */

export interface ScoringRules {
  win: number;
  draw: number;
  loss: number;
}

export const DEFAULT_SCORING: ScoringRules = { win: 3, draw: 1, loss: 0 };

export interface MatchResult {
  homeScore: number;
  awayScore: number;
}

export type MatchStatus = 'scheduled' | 'played' | 'canceled';

export interface Match {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchStatus;
  result: MatchResult | null;
}

export type RankingEvent =
  | { type: 'result_recorded'; matchId: string; homeScore: number; awayScore: number }
  | { type: 'result_corrected'; matchId: string; homeScore: number; awayScore: number }
  | { type: 'match_canceled'; matchId: string };

interface MutableStats {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pointsFor: number;
  pointsAgainst: number;
  points: number;
}

export interface TeamStats {
  teamId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pointsFor: number;
  pointsAgainst: number;
  diff: number;
  points: number;
}

export interface Standing extends TeamStats {
  rank: number;
}

function zeroStats(): MutableStats {
  return { played: 0, won: 0, drawn: 0, lost: 0, pointsFor: 0, pointsAgainst: 0, points: 0 };
}

function diffOf(s: MutableStats): number {
  return s.pointsFor - s.pointsAgainst;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toStanding(teamId: string, s: MutableStats, rank: number): Standing {
  return {
    rank,
    teamId,
    played: s.played,
    won: s.won,
    drawn: s.drawn,
    lost: s.lost,
    pointsFor: s.pointsFor,
    pointsAgainst: s.pointsAgainst,
    diff: diffOf(s),
    points: s.points,
  };
}

export class RankingTable {
  private readonly scoring: ScoringRules;
  private readonly stats = new Map<string, MutableStats>();
  private readonly matches = new Map<string, Match>();
  private readonly eventLog: RankingEvent[] = [];
  /** 当前名次顺序（增量维护，teamId 从第 1 名到最后一名）。 */
  private order: string[] = [];

  constructor(options: { scoring?: Partial<ScoringRules> } = {}) {
    this.scoring = { ...DEFAULT_SCORING, ...options.scoring };
  }

  addTeam(teamId: string): void {
    if (this.stats.has(teamId)) throw new Error(`duplicate team: ${teamId}`);
    this.stats.set(teamId, zeroStats());
    this.order.push(teamId);
    // 新队伍加入其积分组后，重算该组使名次始终与完整重算一致
    this.reclassify([teamId], new Map([[teamId, 0]]));
  }

  teamIds(): string[] {
    return [...this.stats.keys()];
  }

  events(): readonly RankingEvent[] {
    return this.eventLog;
  }

  getMatch(matchId: string): Match {
    return { ...this.matchRef(matchId) };
  }

  scheduleMatch(matchId: string, homeTeamId: string, awayTeamId: string): void {
    if (this.matches.has(matchId)) throw new Error(`duplicate match: ${matchId}`);
    this.requireTeam(homeTeamId);
    this.requireTeam(awayTeamId);
    if (homeTeamId === awayTeamId) throw new Error(`team cannot play itself: ${homeTeamId}`);
    this.matches.set(matchId, { id: matchId, homeTeamId, awayTeamId, status: 'scheduled', result: null });
  }

  /** 录入比赛结果（事件）。返回本次重算名次涉及的队伍。 */
  recordResult(matchId: string, homeScore: number, awayScore: number): string[] {
    const m = this.matchRef(matchId);
    if (m.status !== 'scheduled') {
      throw new Error(`match ${matchId} is ${m.status}; use correctResult/cancelMatch`);
    }
    m.status = 'played';
    m.result = { homeScore, awayScore };
    this.eventLog.push({ type: 'result_recorded', matchId, homeScore, awayScore });
    return this.applyDelta(m, null, m.result);
  }

  /** 排程并录入结果的便捷方法。 */
  addResult(matchId: string, homeTeamId: string, awayTeamId: string, homeScore: number, awayScore: number): string[] {
    this.scheduleMatch(matchId, homeTeamId, awayTeamId);
    return this.recordResult(matchId, homeScore, awayScore);
  }

  /** 更正已录入的比赛结果（事件）。返回本次重算名次涉及的队伍。 */
  correctResult(matchId: string, homeScore: number, awayScore: number): string[] {
    const m = this.matchRef(matchId);
    if (m.status !== 'played' || m.result === null) {
      throw new Error(`match ${matchId} is ${m.status}; cannot correct result`);
    }
    const prev = m.result;
    m.result = { homeScore, awayScore };
    this.eventLog.push({ type: 'result_corrected', matchId, homeScore, awayScore });
    return this.applyDelta(m, prev, m.result);
  }

  /** 取消场次（事件）。已比赛的场次会回滚其积分。返回本次重算名次涉及的队伍。 */
  cancelMatch(matchId: string): string[] {
    const m = this.matchRef(matchId);
    if (m.status === 'canceled') throw new Error(`match ${matchId} already canceled`);
    const prev = m.result;
    m.status = 'canceled';
    m.result = null;
    this.eventLog.push({ type: 'match_canceled', matchId });
    if (prev === null) return []; // 未比赛的场次取消不影响积分
    return this.applyDelta(m, prev, null);
  }

  /** 当前名次（增量维护的结果）。 */
  getStandings(): Standing[] {
    return this.order.map((id, i) => toStanding(id, this.stats.get(id)!, i + 1));
  }

  /** 从比赛记录完整重算全部积分与名次，用于核对增量结果。 */
  fullRecompute(): Standing[] {
    const fresh = new Map<string, MutableStats>();
    for (const id of this.stats.keys()) fresh.set(id, zeroStats());
    for (const m of this.matches.values()) {
      if (m.status === 'played' && m.result !== null) {
        this.applyResultTo(fresh, m, m.result, 1);
      }
    }
    const order = this.sortByPointsThenTieBreak([...fresh.keys()], fresh);
    return order.map((id, i) => toStanding(id, fresh.get(id)!, i + 1));
  }

  /** 校验增量维护的名次与完整重算一致；不一致则抛出异常。 */
  assertConsistent(): void {
    const expected = this.fullRecompute();
    const actual = this.getStandings();
    const fmt = (s: Standing[]) => s.map((x) => `${x.rank}:${x.teamId}(${x.points})`).join(' ');
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`incremental standings diverged from full recompute\nincremental: ${fmt(actual)}\nfull:        ${fmt(expected)}`);
    }
  }

  // ---- 内部实现 ----

  private requireTeam(teamId: string): void {
    if (!this.stats.has(teamId)) throw new Error(`unknown team: ${teamId}`);
  }

  private matchRef(matchId: string): Match {
    const m = this.matches.get(matchId);
    if (!m) throw new Error(`unknown match: ${matchId}`);
    return m;
  }

  /** 应用积分变化（撤销旧结果 + 应用新结果），然后增量重算受影响名次。 */
  private applyDelta(m: Match, prev: MatchResult | null, next: MatchResult | null): string[] {
    const affected = [m.homeTeamId, m.awayTeamId];
    const oldPoints = new Map<string, number>();
    for (const id of affected) oldPoints.set(id, this.stats.get(id)!.points);
    if (prev !== null) this.applyResultTo(this.stats, m, prev, -1);
    if (next !== null) this.applyResultTo(this.stats, m, next, 1);
    return this.reclassify(affected, oldPoints);
  }

  private applyResultTo(stats: Map<string, MutableStats>, m: Match, r: MatchResult, sign: 1 | -1): void {
    const home = stats.get(m.homeTeamId)!;
    const away = stats.get(m.awayTeamId)!;
    home.played += sign;
    away.played += sign;
    home.pointsFor += sign * r.homeScore;
    home.pointsAgainst += sign * r.awayScore;
    away.pointsFor += sign * r.awayScore;
    away.pointsAgainst += sign * r.homeScore;
    if (r.homeScore > r.awayScore) {
      home.won += sign;
      away.lost += sign;
      home.points += sign * this.scoring.win;
      away.points += sign * this.scoring.loss;
    } else if (r.homeScore < r.awayScore) {
      away.won += sign;
      home.lost += sign;
      away.points += sign * this.scoring.win;
      home.points += sign * this.scoring.loss;
    } else {
      home.drawn += sign;
      away.drawn += sign;
      home.points += sign * this.scoring.draw;
      away.points += sign * this.scoring.draw;
    }
  }

  /**
   * 增量重算：只有积分值涉及变化（旧值或新值）的积分组需要重新排序，
   * 其余积分组的成员与组内比赛均未变化，保持原有相对顺序。
   * 返回名次被重算的队伍。
   */
  private reclassify(affected: string[], oldPoints: Map<string, number>): string[] {
    const pointValues = new Set<number>();
    for (const id of affected) {
      pointValues.add(oldPoints.get(id)!);
      pointValues.add(this.stats.get(id)!.points);
    }
    const byPoints = new Map<number, string[]>();
    for (const id of this.order) {
      const p = this.stats.get(id)!.points;
      const group = byPoints.get(p);
      if (group) group.push(id);
      else byPoints.set(p, [id]);
    }
    const recomputed: string[] = [];
    const newOrder: string[] = [];
    for (const [pts, group] of [...byPoints.entries()].sort((a, b) => b[0] - a[0])) {
      if (pointValues.has(pts)) {
        newOrder.push(...this.resolveTie(group));
        recomputed.push(...group);
      } else {
        newOrder.push(...group); // 未受影响：保持原顺序
      }
    }
    this.order = newOrder;
    return recomputed;
  }

  /** 完整排序：先按积分分组（降序），同分组内走递归平局规则。 */
  private sortByPointsThenTieBreak(ids: string[], stats: Map<string, MutableStats>): string[] {
    const byPoints = new Map<number, string[]>();
    for (const id of ids) {
      const p = stats.get(id)!.points;
      const group = byPoints.get(p);
      if (group) group.push(id);
      else byPoints.set(p, [id]);
    }
    const out: string[] = [];
    for (const [, group] of [...byPoints.entries()].sort((a, b) => b[0] - a[0])) {
      out.push(...this.resolveTie(group));
    }
    return out;
  }

  /**
   * 递归平局规则：对同分组统计组内小联赛，按（小联赛积分, 小联赛净胜分）分桶；
   * 仍未分出的子组递归处理；若子组与原组相同（无进展）则按 ID 升序。
   */
  private resolveTie(group: string[]): string[] {
    if (group.length < 2) return [...group];
    const scoped = this.scopedStats(group);
    const decorated = group.map((id) => ({ id, s: scoped.get(id)! }));
    decorated.sort((a, b) =>
      b.s.points - a.s.points || diffOf(b.s) - diffOf(a.s) || compareIds(a.id, b.id),
    );
    const out: string[] = [];
    let bucket: string[] = [];
    let bucketKey = '';
    const flush = (): void => {
      if (bucket.length === 0) return;
      if (bucket.length === 1) {
        out.push(bucket[0]!);
      } else if (bucket.length === group.length) {
        out.push(...[...bucket].sort(compareIds)); // 递归无进展，按 ID
      } else {
        out.push(...this.resolveTie(bucket)); // 范围缩小，递归同一规则
      }
      bucket = [];
    };
    for (const { id, s } of decorated) {
      const key = `${s.points}|${diffOf(s)}`;
      if (bucket.length > 0 && key !== bucketKey) flush();
      bucket.push(id);
      bucketKey = key;
    }
    flush();
    return out;
  }

  /** 只统计组内成员之间已比赛场次的积分数据（小联赛）。 */
  private scopedStats(group: string[]): Map<string, MutableStats> {
    const inGroup = new Set(group);
    const scoped = new Map<string, MutableStats>();
    for (const id of group) scoped.set(id, zeroStats());
    for (const m of this.matches.values()) {
      if (m.status !== 'played' || m.result === null) continue;
      if (!inGroup.has(m.homeTeamId) || !inGroup.has(m.awayTeamId)) continue;
      this.applyResultTo(scoped, m, m.result, 1);
    }
    return scoped;
  }
}
