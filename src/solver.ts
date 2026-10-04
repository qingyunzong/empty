import { MAX_AMOUNT, type Problem, type Solution } from "./types.js";

interface Entry {
  imp: number;
  cost: number;
  rev: number;
  amounts: number[];
}

/**
 * 支配剪枝：若存在 imp' >= imp、cost' <= cost、rev' >= rev 的另一条目，则本条被支配。
 * 目标为收益最大、并列时成本最低，因此被支配条目不可能属于更优解。
 * 三维支配按 imp 分层处理：层内按 cost 升序扫描，层间用 (cost, rev) 帕累托结构查询。
 */
function prune(entries: Entry[]): Entry[] {
  entries.sort((a, b) => b.imp - a.imp || a.cost - b.cost || b.rev - a.rev);
  const kept: Entry[] = [];
  // 已处理（更高 imp）条目的二维帕累托前沿：paretoCost 升序、paretoRev 严格升序。
  let paretoCost: number[] = [];
  let paretoRev: number[] = [];
  let i = 0;
  while (i < entries.length) {
    let j = i;
    while (j < entries.length && (entries[j] as Entry).imp === (entries[i] as Entry).imp) j++;
    let levelMaxRev = -1;
    const levelKept: Entry[] = [];
    for (let k = i; k < j; k++) {
      const e = entries[k] as Entry;
      if (e.rev <= levelMaxRev) continue; // 同层内被成本更低/相等且收益更高的条目支配
      levelMaxRev = e.rev;
      // 更高层中是否存在 cost' <= e.cost 且 rev' >= e.rev
      let lo = 0;
      let hi = paretoCost.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((paretoCost[mid] as number) <= e.cost) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && (paretoRev[lo - 1] as number) >= e.rev) continue;
      levelKept.push(e);
    }
    if (levelKept.length > 0) {
      const merged = [
        ...paretoCost.map((cost, idx) => ({ cost, rev: paretoRev[idx] as number })),
        ...levelKept.map((e) => ({ cost: e.cost, rev: e.rev })),
      ];
      merged.sort((a, b) => a.cost - b.cost || b.rev - a.rev);
      paretoCost = [];
      paretoRev = [];
      let maxRev = -1;
      for (const p of merged) {
        if (p.rev > maxRev) {
          paretoCost.push(p.cost);
          paretoRev.push(p.rev);
          maxRev = p.rev;
        }
      }
      kept.push(...levelKept);
    }
    i = j;
  }
  return kept;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv;
  }
  return false;
}

function better(a: Entry, b: Entry): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.cost !== b.cost) return a.cost < b.cost;
  return lexLess(a.amounts, b.amounts);
}

interface IndexedGroup {
  index: number;
  channel: string;
  unitCost: number;
  unitImpressions: number;
  revenue: number[];
}

/** 单渠道前沿：在该渠道预算内，其全部广告组投放组合的帕累托最优集合。 */
function channelFrontier(
  groups: IndexedGroup[],
  budget: number,
  cap: number,
  stats: { statesExplored: number },
): Entry[] {
  let frontier: Entry[] = [{ imp: 0, cost: 0, rev: 0, amounts: [] }];
  for (const g of groups) {
    const next: Entry[] = [];
    for (const e of frontier) {
      for (let x = 0; x <= MAX_AMOUNT; x++) {
        const cost = e.cost + x * g.unitCost;
        if (cost > budget) continue;
        next.push({
          imp: Math.min(cap, e.imp + x * g.unitImpressions),
          cost,
          rev: e.rev + (g.revenue[x] as number),
          amounts: [...e.amounts, x],
        });
      }
    }
    stats.statesExplored += next.length;
    frontier = prune(next);
  }
  return frontier;
}

/**
 * 精确求解：先按渠道生成满足各自预算的帕累托前沿，再跨渠道合并
 * （曝光量超过下限即截断，因为目标只关心收益与成本）。
 */
export function solve(problem: Problem): Solution {
  const cap = problem.minImpressions;
  const stats = { statesExplored: 0 };
  const n = problem.groups.length;

  const byChannel = new Map<string, IndexedGroup[]>();
  problem.groups.forEach((g, index) => {
    const list = byChannel.get(g.channel) ?? [];
    list.push({ index, ...g });
    byChannel.set(g.channel, list);
  });

  let frontier: Entry[] = [{ imp: 0, cost: 0, rev: 0, amounts: new Array<number>(n).fill(0) }];
  for (const channel of problem.channels) {
    const members = byChannel.get(channel.id);
    if (!members || members.length === 0) continue;
    const cf = channelFrontier(members, channel.budget, cap, stats);
    const next: Entry[] = [];
    for (const e of frontier) {
      for (const f of cf) {
        const amounts = e.amounts.slice();
        members.forEach((g, i) => {
          amounts[g.index] = f.amounts[i] as number;
        });
        next.push({
          imp: Math.min(cap, e.imp + f.imp),
          cost: e.cost + f.cost,
          rev: e.rev + f.rev,
          amounts,
        });
      }
    }
    stats.statesExplored += next.length;
    frontier = prune(next);
  }

  let best: Entry | null = null;
  for (const e of frontier) {
    if (e.imp < cap) continue;
    if (best === null || better(e, best)) best = e;
  }

  if (best === null) {
    return { feasible: false, revenue: 0, cost: 0, impressions: 0, amounts: null, stats };
  }
  const amounts = best.amounts.map((a) => a ?? 0);
  const impressions = amounts.reduce((sum, x, i) => sum + x * (problem.groups[i]?.unitImpressions ?? 0), 0);
  return {
    feasible: true,
    revenue: best.rev,
    cost: best.cost,
    impressions,
    amounts,
    stats,
  };
}

export interface BruteForceResult extends Solution {
  nodes: number;
}

/** 穷举全部 11^n 组合，用于小规模对照验证。 */
export function bruteForce(problem: Problem, combinationLimit = 100_000_000): BruteForceResult {
  const n = problem.groups.length;
  let combinations = 1;
  for (let i = 0; i < n; i++) combinations *= MAX_AMOUNT + 1;
  if (combinations > combinationLimit) {
    throw new Error(`brute force refused: 11^${n} = ${combinations} combinations exceeds limit ${combinationLimit}`);
  }

  const cap = problem.minImpressions;
  const channelIndex = new Map<string, number>();
  problem.channels.forEach((c, i) => channelIndex.set(c.id, i));
  const budgets = problem.channels.map((c) => c.budget);
  const spent = new Array<number>(budgets.length).fill(0);
  const amounts = new Array<number>(n).fill(0);

  let nodes = 0;
  let best: Entry | null = null;

  const dfs = (i: number, rev: number, cost: number, imp: number): void => {
    if (i === n) {
      nodes++;
      if (imp < cap) return;
      const candidate: Entry = { imp, cost, rev, amounts: amounts.slice() };
      if (best === null || better(candidate, best)) best = candidate;
      return;
    }
    const g = problem.groups[i] as (typeof problem.groups)[number];
    const ci = channelIndex.get(g.channel) as number;
    const budget = budgets[ci] as number;
    for (let x = 0; x <= MAX_AMOUNT; x++) {
      const add = x * g.unitCost;
      if ((spent[ci] as number) + add > budget) continue;
      spent[ci] = (spent[ci] as number) + add;
      amounts[i] = x;
      dfs(i + 1, rev + (g.revenue[x] as number), cost + add, Math.min(cap, imp + x * g.unitImpressions));
      spent[ci] = (spent[ci] as number) - add;
    }
  };
  dfs(0, 0, 0, 0);

  if (best === null) {
    return { feasible: false, revenue: 0, cost: 0, impressions: 0, amounts: null, stats: { statesExplored: nodes }, nodes };
  }
  const b: Entry = best;
  const impressions = b.amounts.reduce((sum, x, i) => sum + x * (problem.groups[i]?.unitImpressions ?? 0), 0);
  return {
    feasible: true,
    revenue: b.rev,
    cost: b.cost,
    impressions,
    amounts: b.amounts,
    stats: { statesExplored: nodes },
    nodes,
  };
}
