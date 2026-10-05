// Independent finite-state verification: a forward Dijkstra shortest-path
// search over the explicit state graph (day, inventory) with lexicographic
// weights (deviation, money). Written independently from the backward DP in
// core.ts so the two cross-check each other's decisions.

import { SolveInput, Cost, DayDecision, cmpCost } from "./core";

export interface FiniteStateResult {
  cost: Cost;
  decisions: DayDecision[];
}

interface HeapItem {
  dev: number;
  money: number;
  state: number;
}

function itemLess(a: HeapItem, b: HeapItem): boolean {
  if (a.dev !== b.dev) return a.dev < b.dev;
  return a.money < b.money;
}

class MinHeap {
  private data: HeapItem[] = [];
  get size(): number {
    return this.data.length;
  }
  push(item: HeapItem): void {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (itemLess(d[i], d[p])) {
        const tmp = d[i];
        d[i] = d[p];
        d[p] = tmp;
        i = p;
      } else break;
    }
  }
  pop(): HeapItem {
    const d = this.data;
    const top = d[0];
    const last = d.pop() as HeapItem;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && itemLess(d[l], d[m])) m = l;
        if (r < d.length && itemLess(d[r], d[m])) m = r;
        if (m === i) break;
        const tmp = d[i];
        d[i] = d[m];
        d[m] = tmp;
        i = m;
      }
    }
    return top;
  }
}

export function finiteStateSearch(input: SolveInput): FiniteStateResult | null {
  const T = input.demand.length;
  const C = input.capacity;
  const S = input.streams.length;
  const width = C + 1;
  const start = input.initialInventory; // t=0 row
  const dist: (Cost | null)[] = new Array<Cost | null>((T + 1) * width).fill(null);
  const parent: number[] = new Array<number>((T + 1) * width).fill(-1);
  const parentQ: (number[] | null)[] = new Array<number[] | null>((T + 1) * width).fill(null);
  dist[start] = { dev: 0, money: 0 };
  const heap = new MinHeap();
  heap.push({ dev: 0, money: 0, state: start });

  while (heap.size > 0) {
    const cur = heap.pop();
    const curDist = dist[cur.state];
    if (curDist == null) continue;
    if (cur.dev !== curDist.dev || cur.money !== curDist.money) continue; // stale
    const t = Math.floor(cur.state / width);
    if (t === T) continue;
    const i = cur.state % width;
    const d = input.demand[t];
    const slotT = input.slots[t];
    const q = new Array<number>(S).fill(0);
    const visit = (s: number, total: number, money: number, dev: number): void => {
      if (s === S) {
        if (i + total < d) return;
        const end = i + total - d;
        const nState = (t + 1) * width + end;
        const nCost: Cost = { dev, money: money + input.holdingCost * end };
        const old = dist[nState];
        if (old === null || cmpCost(nCost, old) < 0) {
          dist[nState] = nCost;
          parent[nState] = cur.state;
          parentQ[nState] = q.slice();
          heap.push({ dev: nCost.dev, money: nCost.money, state: nState });
        }
        return;
      }
      const slot = slotT[s];
      const stream = input.streams[s];
      const qMax = Math.min(slot.max, C - i - total);
      for (let qq = slot.min; qq <= qMax; qq++) {
        q[s] = qq;
        const m = slot.counted && qq > 0 ? stream.fixedCost + stream.unitCost * qq : 0;
        const dv = slot.devBase !== null ? Math.abs(qq - slot.devBase) : 0;
        visit(s + 1, total + qq, money + m, dev + dv);
      }
    };
    visit(0, 0, cur.money, cur.dev);
  }

  let bestState = -1;
  let bestCost: Cost | null = null;
  for (let i = 0; i <= C; i++) {
    const c = dist[T * width + i];
    if (c !== null && (bestCost === null || cmpCost(c, bestCost) < 0)) {
      bestCost = c;
      bestState = T * width + i;
    }
  }
  if (bestCost === null) return null;
  const decisions: DayDecision[] = [];
  let st = bestState;
  while (st !== start) {
    const q = parentQ[st];
    if (q === null) throw new Error("internal error: broken parent chain");
    decisions.unshift({ qty: q.slice() });
    st = parent[st];
  }
  return { cost: bestCost, decisions };
}
