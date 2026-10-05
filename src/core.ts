// Core solver: backward dynamic programming over (day, inventory) with a
// lexicographic objective (deviation from published orders first, then money).
//
// Time reindexing: an order placed on day p with lead L arrives before demand
// on day p+L, so "arrival quantity on day t" is the decision variable; it is
// free only when t >= now+L, otherwise it is committed pipeline / published.

export interface StreamSpec {
  name: string;
  lead: number;
  fixedCost: number; // charged when qty > 0 and slot.counted
  unitCost: number; // per unit when slot.counted
}

export interface ArrivalSlot {
  min: number; // locked / committed minimum arrival
  max: number; // maximum allowed arrival (<= capacity)
  counted: boolean; // whether fixed+unit costs are charged (false => sunk)
  devBase: number | null; // published qty for deviation; null => no deviation
}

export interface SolveInput {
  capacity: number;
  initialInventory: number;
  demand: number[]; // local days 0..T-1
  holdingCost: number; // per unit of end-of-day inventory
  streams: StreamSpec[];
  slots: ArrivalSlot[][]; // slots[t][s]
}

export interface Cost {
  dev: number; // total absolute change to published order quantities
  money: number; // fixed order costs + unit costs + holding costs
}

export function cmpCost(a: Cost, b: Cost): number {
  if (a.dev !== b.dev) return a.dev - b.dev;
  return a.money - b.money;
}

export interface DayDecision {
  qty: number[]; // arrival quantity per stream on this day
}

export interface SolveResult {
  feasible: boolean;
  cost: Cost;
  decisions: DayDecision[];
  endInventory: number[];
}

export function solve(input: SolveInput): SolveResult {
  const T = input.demand.length;
  const C = input.capacity;
  const S = input.streams.length;
  const width = C + 1;
  const f: (Cost | null)[] = new Array<Cost | null>((T + 1) * width).fill(null);
  const choice: (number[] | null)[] = new Array<number[] | null>(T * width).fill(null);
  for (let i = 0; i <= C; i++) f[T * width + i] = { dev: 0, money: 0 };

  for (let t = T - 1; t >= 0; t--) {
    const slotT = input.slots[t];
    const d = input.demand[t];
    for (let i = 0; i <= C; i++) {
      let best: Cost | null = null;
      let bestQ: number[] | null = null;
      const q = new Array<number>(S).fill(0);
      const visit = (s: number, total: number, money: number, dev: number): void => {
        if (s === S) {
          if (i + total < d) return; // stockout forbidden
          const end = i + total - d;
          const next = f[(t + 1) * width + end];
          if (next === null) return;
          const cand: Cost = {
            dev: dev + next.dev,
            money: money + input.holdingCost * end + next.money,
          };
          if (best === null || cmpCost(cand, best) < 0) {
            best = cand;
            bestQ = q.slice();
          }
          return;
        }
        const slot = slotT[s];
        const stream = input.streams[s];
        const qMax = Math.min(slot.max, C - i - total); // capacity at arrival time
        for (let qq = slot.min; qq <= qMax; qq++) {
          q[s] = qq;
          const m = slot.counted && qq > 0 ? stream.fixedCost + stream.unitCost * qq : 0;
          const dv = slot.devBase !== null ? Math.abs(qq - slot.devBase) : 0;
          visit(s + 1, total + qq, money + m, dev + dv);
        }
      };
      visit(0, 0, 0, 0);
      f[t * width + i] = best;
      choice[t * width + i] = bestQ;
    }
  }

  const startCost = f[input.initialInventory];
  if (startCost == null) {
    return { feasible: false, cost: { dev: 0, money: 0 }, decisions: [], endInventory: [] };
  }
  const decisions: DayDecision[] = [];
  const endInventory: number[] = [];
  let inv = input.initialInventory;
  for (let t = 0; t < T; t++) {
    const q = choice[t * width + inv];
    if (q === null) throw new Error("internal error: missing choice on optimal path");
    decisions.push({ qty: q.slice() });
    let total = 0;
    for (const x of q) total += x;
    inv = inv + total - input.demand[t];
    endInventory.push(inv);
  }
  return { feasible: true, cost: startCost, decisions, endInventory };
}

export interface SimRow {
  start: number;
  arrivals: number[];
  demand: number;
  end: number;
  money: number; // order money + holding incurred this day
  dev: number;
}

// Forward simulation of decisions; returns null when any constraint breaks.
export function simulate(input: SolveInput, decisions: DayDecision[]): SimRow[] | null {
  let inv = input.initialInventory;
  const rows: SimRow[] = [];
  for (let t = 0; t < input.demand.length; t++) {
    const q = decisions[t].qty;
    let total = 0;
    let money = 0;
    let dev = 0;
    for (let s = 0; s < input.streams.length; s++) {
      const slot = input.slots[t][s];
      const qq = q[s];
      if (!Number.isInteger(qq) || qq < slot.min || qq > slot.max) return null;
      total += qq;
      if (slot.counted && qq > 0) {
        money += input.streams[s].fixedCost + input.streams[s].unitCost * qq;
      }
      if (slot.devBase !== null) dev += Math.abs(qq - slot.devBase);
    }
    if (inv + total > input.capacity) return null;
    if (inv + total < input.demand[t]) return null;
    const end = inv + total - input.demand[t];
    money += input.holdingCost * end;
    rows.push({ start: inv, arrivals: q.slice(), demand: input.demand[t], end, money, dev });
    inv = end;
  }
  return rows;
}
