/**
 * 指派问题求解器：n 个工单 <-> n 个工位，一对一，允许负费用，支持禁配。
 * 算法：匈牙利算法（O(n^3)，大 M 处理禁配边）+ 最大流提取 Hall 见证。
 */

export interface Problem {
  orderIds: string[];
  stationIds: string[];
  /** cost[i][j]：工单 i 派给工位 j 的费用（仅 allowed 对有意义）。 */
  cost: number[][];
  /** allowed[i][j]：是否允许该配对（禁配为 false）。 */
  allowed: boolean[][];
}

export interface OptimalSolution {
  status: "optimal";
  cost: number;
  /** match[i] = j 表示工单 i 派给工位 j。 */
  match: number[];
  /** 对偶证书：u_i + v_j <= cost[i][j]（所有允许对），匹配边上取等号，sum(u)+sum(v)=cost。 */
  dual: { u: number[]; v: number[] };
}

export interface InfeasibleResult {
  status: "infeasible";
  /** Hall 见证：工单子集 S 的可配工位邻集 N(S) 满足 |N(S)| < |S|。 */
  hallWitness: { orders: number[]; neighborhood: number[] };
}

export type SolveResult = OptimalSolution | InfeasibleResult;

/** 匈牙利算法（最小化，方阵，允许负费用）。返回匹配与对偶势。 */
export function hungarian(a: number[][]): { match: number[]; u: number[]; v: number[]; cost: number } {
  const n = a.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const match = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] !== 0) match[p[j] - 1] = j - 1;
  }
  let cost = 0;
  for (let i = 0; i < n; i++) cost += a[i][match[i]];
  return { match, u: u.slice(1), v: v.slice(1), cost };
}

/**
 * 最大流（BFS 增广）求最大匹配；若不满 n，则在残余图中取源点可达的工单集合 S，
 * 即为 Hall 见证（|N(S)| < |S|）。
 */
export function maxMatchingHall(
  n: number,
  allowed: boolean[][]
): { size: number; hallWitness: { orders: number[]; neighborhood: number[] } | null } {
  const S = 0;
  const T = 2 * n + 1;
  const N = 2 * n + 2;
  const cap: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let i = 0; i < n; i++) cap[S][1 + i] = 1;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (allowed[i][j]) cap[1 + i][1 + n + j] = 1;
  for (let j = 0; j < n; j++) cap[1 + n + j][T] = 1;

  let flow = 0;
  for (;;) {
    const prev = new Array<number>(N).fill(-1);
    prev[S] = S;
    const queue = [S];
    while (queue.length > 0 && prev[T] === -1) {
      const x = queue.shift()!;
      for (let y = 0; y < N; y++) {
        if (prev[y] === -1 && cap[x][y] > 0) {
          prev[y] = x;
          queue.push(y);
        }
      }
    }
    if (prev[T] === -1) break;
    for (let y = T; y !== S; y = prev[y]) {
      cap[prev[y]][y] -= 1;
      cap[y][prev[y]] += 1;
    }
    flow++;
  }
  if (flow === n) return { size: flow, hallWitness: null };

  // 残余图中从源点可达的节点集合
  const reach = new Array<boolean>(N).fill(false);
  reach[S] = true;
  const queue = [S];
  while (queue.length > 0) {
    const x = queue.shift()!;
    for (let y = 0; y < N; y++) {
      if (!reach[y] && cap[x][y] > 0) {
        reach[y] = true;
        queue.push(y);
      }
    }
  }
  const orders: number[] = [];
  for (let i = 0; i < n; i++) if (reach[1 + i]) orders.push(i);
  const neighborSet = new Set<number>();
  for (const i of orders)
    for (let j = 0; j < n; j++) if (allowed[i][j]) neighborSet.add(j);
  return { size: flow, hallWitness: { orders, neighborhood: [...neighborSet].sort((a, b) => a - b) } };
}

export function solve(problem: Problem): SolveResult {
  const n = problem.orderIds.length;
  let maxAbs = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (problem.allowed[i][j]) maxAbs = Math.max(maxAbs, Math.abs(problem.cost[i][j]));
  // 大 M：保证“任何可行完美匹配”都优于“任何用了禁配边的匹配”。
  const M = 2 * n * (maxAbs + 1) + 1;
  const a: number[][] = [];
  for (let i = 0; i < n; i++) {
    a.push([]);
    for (let j = 0; j < n; j++) a[i].push(problem.allowed[i][j] ? problem.cost[i][j] : M);
  }
  const { match, u, v } = hungarian(a);
  let usesForbidden = false;
  for (let i = 0; i < n; i++) if (!problem.allowed[i][match[i]]) usesForbidden = true;

  if (usesForbidden) {
    const { hallWitness } = maxMatchingHall(n, problem.allowed);
    if (!hallWitness) throw new Error("internal: infeasible but no Hall witness");
    return { status: "infeasible", hallWitness };
  }
  let cost = 0;
  for (let i = 0; i < n; i++) cost += problem.cost[i][match[i]];
  return { status: "optimal", cost, match, dual: { u, v } };
}
