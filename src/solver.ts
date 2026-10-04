export interface Tier {
  minQty: number;
  unitPriceCents: number;
}

export interface Supplier {
  name: string;
  moq: number;
  freightThresholdCents: number;
  freightFeeCents: number;
  tiers: Tier[];
}

export interface LineResult {
  supplier: string;
  qty: number;
  unitPriceCents: number;
  goodsCents: number;
  freightCents: number;
  totalCents: number;
}

export interface SolveResult {
  demand: number;
  totalCents: number;
  supplierCount: number;
  lines: LineResult[];
}

export function unitPriceFor(supplier: Supplier, qty: number): number {
  let price = supplier.tiers[0].unitPriceCents;
  for (const tier of supplier.tiers) {
    if (qty >= tier.minQty) price = tier.unitPriceCents;
  }
  return price;
}

export function lineCost(supplier: Supplier, qty: number): LineResult | null {
  if (qty === 0) return null;
  if (qty < supplier.moq) return null;
  const unitPriceCents = unitPriceFor(supplier, qty);
  const goodsCents = qty * unitPriceCents;
  const freightCents =
    goodsCents >= supplier.freightThresholdCents ? 0 : supplier.freightFeeCents;
  return {
    supplier: supplier.name,
    qty,
    unitPriceCents,
    goodsCents,
    freightCents,
    totalCents: goodsCents + freightCents,
  };
}

interface DpCell {
  cost: number;
  count: number;
}

function better(a: DpCell, b: DpCell): boolean {
  return a.cost < b.cost || (a.cost === b.cost && a.count < b.count);
}

export function solve(suppliers: Supplier[], demand: number): SolveResult {
  if (!Number.isInteger(demand) || demand < 0) {
    throw new Error(`demand must be a non-negative integer, got ${demand}`);
  }
  if (suppliers.length > 6) {
    throw new Error(`at most 6 suppliers supported, got ${suppliers.length}`);
  }
  const n = suppliers.length;
  const INF = Number.POSITIVE_INFINITY;

  const costs: (LineResult | null)[][] = suppliers.map((s) => {
    const row: (LineResult | null)[] = new Array(demand + 1).fill(null);
    for (let q = 1; q <= demand; q++) row[q] = lineCost(s, q);
    return row;
  });

  let dp: DpCell[] = new Array(demand + 1).fill(null).map(() => ({ cost: INF, count: 0 }));
  dp[0] = { cost: 0, count: 0 };
  const choice: number[][] = [];

  for (let i = 0; i < n; i++) {
    const next: DpCell[] = new Array(demand + 1).fill(null).map(() => ({ cost: INF, count: 0 }));
    const pick: number[] = new Array(demand + 1).fill(-1);
    for (let d = 0; d <= demand; d++) {
      if (dp[d].cost === INF) continue;
      for (let q = 0; q + d <= demand; q++) {
        const line = q === 0 ? null : costs[i][q];
        if (q > 0 && line === null) continue;
        const cand: DpCell = {
          cost: dp[d].cost + (line ? line.totalCents : 0),
          count: dp[d].count + (q > 0 ? 1 : 0),
        };
        if (better(cand, next[d + q])) {
          next[d + q] = cand;
          pick[d + q] = q;
        }
      }
    }
    choice.push(pick);
    dp = next;
  }

  if (dp[demand].cost === INF) {
    throw new Error(`no feasible plan: demand ${demand} cannot be fulfilled`);
  }

  const qtys = new Array(n).fill(0);
  let rest = demand;
  for (let i = n - 1; i >= 0; i--) {
    qtys[i] = choice[i][rest];
    rest -= qtys[i];
  }

  const lines: LineResult[] = [];
  for (let i = 0; i < n; i++) {
    if (qtys[i] > 0) lines.push(costs[i][qtys[i]] as LineResult);
  }
  return {
    demand,
    totalCents: dp[demand].cost,
    supplierCount: dp[demand].count,
    lines,
  };
}

export function solveBruteForce(suppliers: Supplier[], demand: number): SolveResult {
  const n = suppliers.length;
  let best: DpCell = { cost: Number.POSITIVE_INFINITY, count: 0 };
  let bestQtys: number[] = [];
  const qtys = new Array(n).fill(0);

  function dfs(i: number, remaining: number, cost: number, count: number): void {
    if (cost > best.cost) return;
    if (i === n) {
      if (remaining !== 0) return;
      const cand: DpCell = { cost, count };
      if (better(cand, best)) {
        best = cand;
        bestQtys = qtys.slice();
      }
      return;
    }
    for (let q = 0; q <= remaining; q++) {
      const line = q === 0 ? null : lineCost(suppliers[i], q);
      if (q > 0 && line === null) continue;
      qtys[i] = q;
      dfs(i + 1, remaining - q, cost + (line ? line.totalCents : 0), count + (q > 0 ? 1 : 0));
    }
    qtys[i] = 0;
  }
  dfs(0, demand, 0, 0);

  if (best.cost === Number.POSITIVE_INFINITY) {
    throw new Error(`no feasible plan: demand ${demand} cannot be fulfilled`);
  }
  const lines: LineResult[] = [];
  for (let i = 0; i < n; i++) {
    if (bestQtys[i] > 0) lines.push(lineCost(suppliers[i], bestQtys[i]) as LineResult);
  }
  return { demand, totalCents: best.cost, supplierCount: best.count, lines };
}
