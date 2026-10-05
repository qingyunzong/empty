import type { Problem, SolveResult, OptimalResult, InfeasibleResult } from "./types.js";

export const MAX_N = 12;

/** Validate raw input shape and normalize into a Problem. Throws on invalid input. */
export function parseProblem(raw: unknown): Problem {
  if (typeof raw !== "object" || raw === null) throw new Error("input must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const { orders, stations, costs } = obj;
  if (!Array.isArray(orders) || !Array.isArray(stations) || !Array.isArray(costs)) {
    throw new Error("input must have arrays: orders, stations, costs");
  }
  const n = orders.length;
  if (n < 1 || n > MAX_N) throw new Error(`order count must be 1..${MAX_N}, got ${n}`);
  if (stations.length !== n) throw new Error(`stations (${stations.length}) must equal orders (${n})`);
  const ids = (xs: unknown[], what: string): string[] =>
    xs.map((x, i) => {
      if (typeof x !== "string" || x.length === 0) throw new Error(`${what}[${i}] must be a non-empty string`);
      return x;
    });
  const orderIds = ids(orders, "orders");
  const stationIds = ids(stations, "stations");
  if (new Set(orderIds).size !== n) throw new Error("duplicate order IDs");
  if (new Set(stationIds).size !== n) throw new Error("duplicate station IDs");
  if (costs.length !== n) throw new Error(`costs must have ${n} rows`);
  const matrix: (number | null)[][] = costs.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) throw new Error(`costs[${i}] must be an array of length ${n}`);
    return row.map((c, j) => {
      if (c === null || c === "x" || c === "X") return null;
      if (typeof c !== "number" || !Number.isFinite(c)) {
        throw new Error(`costs[${i}][${j}] must be a finite number or null (forbidden)`);
      }
      return c;
    });
  });
  return { orders: orderIds, stations: stationIds, costs: matrix };
}

/**
 * Hungarian algorithm, O(n^3), minimization on a complete square matrix.
 * Handles arbitrary (including negative) costs.
 * Returns min cost, row->col matching, and dual potentials u, v with
 * u[i] + v[j] <= a[i][j] for all i,j and equality on matched pairs.
 */
export function hungarian(a: number[][]): { cost: number; matching: number[]; u: number[]; v: number[] } {
  const n = a.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0); // p[j] = row matched to column j (1-indexed)
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const matching = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) matching[p[j]! - 1] = j - 1;
  const cost = -v[0]! + 0; // normalize -0 to 0
  return { cost, matching, u: u.slice(1), v: v.slice(1) };
}

/** Allowed-edge adjacency: adj[i] = list of station indices order i may use. */
export function allowedAdjacency(problem: Problem): number[][] {
  return problem.costs.map((row) => row.flatMap((c, j) => (c === null ? [] : [j])));
}

/** Max bipartite matching on the allowed graph (Kuhn's algorithm; n <= 12). */
export function maxMatching(adj: number[][]): { size: number; matchRow: number[]; matchCol: number[] } {
  const n = adj.length;
  const matchRow = new Array<number>(n).fill(-1);
  const matchCol = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const seen = new Array<boolean>(n).fill(false);
    const dfs = (x: number): boolean => {
      for (const y of adj[x]!) {
        if (seen[y]!) continue;
        seen[y] = true;
        if (matchCol[y] === -1 || dfs(matchCol[y]!)) {
          matchCol[y] = x;
          matchRow[x] = y;
          return true;
        }
      }
      return false;
    };
    dfs(i);
  }
  return { size: matchRow.filter((m) => m !== -1).length, matchRow, matchCol };
}

/**
 * Hall witness from a non-perfect max matching: alternating BFS from unmatched
 * rows. S = reachable rows, T = reachable columns; then N(S) = T and
 * |T| < |S| because every column in T is matched into S while S contains an
 * unmatched row.
 */
export function hallWitness(adj: number[][], matchRow: number[], matchCol: number[]): { rows: number[]; neighbors: number[] } {
  const n = adj.length;
  const rowSeen = new Array<boolean>(n).fill(false);
  const colSeen = new Array<boolean>(n).fill(false);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (matchRow[i] === -1) {
      rowSeen[i] = true;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.shift()!;
    for (const j of adj[i]!) {
      if (colSeen[j]) continue;
      colSeen[j] = true;
      const r = matchCol[j]!;
      if (r !== -1 && !rowSeen[r]) {
        rowSeen[r] = true;
        queue.push(r);
      }
    }
  }
  const rows = rowSeen.flatMap((s, i) => (s ? [i] : []));
  const neighbors = colSeen.flatMap((s, j) => (s ? [j] : []));
  return { rows, neighbors };
}

/**
 * Solve the assignment problem.
 * Forbidden edges are handled by padding with a big-M cost chosen so that any
 * all-allowed perfect matching strictly beats any matching using a forbidden
 * edge; the Hungarian duals then remain a valid certificate for allowed edges.
 */
export function solve(problem: Problem): SolveResult {
  const n = problem.orders.length;
  const adj = allowedAdjacency(problem);
  const mm = maxMatching(adj);
  if (mm.size < n) {
    const hall = hallWitness(adj, mm.matchRow, mm.matchCol);
    const result: InfeasibleResult = { status: "infeasible", hall };
    return result;
  }
  let sumAbs = 0;
  for (const row of problem.costs) for (const c of row) if (c !== null) sumAbs += Math.abs(c);
  const bigM = 2 * sumAbs + 1;
  const padded = problem.costs.map((row) => row.map((c) => (c === null ? bigM : c)));
  const { cost, matching, u, v } = hungarian(padded);
  if (cost >= bigM) {
    // Defensive: feasibility check above should make this unreachable.
    const hall = hallWitness(adj, mm.matchRow, mm.matchCol);
    return { status: "infeasible", hall };
  }
  const result: OptimalResult = { status: "optimal", cost, matching, dual: { u, v } };
  return result;
}
