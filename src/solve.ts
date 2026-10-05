/**
 * Primary solver: Dijkstra over (doneMask, heat) states.
 * Edge cost = elapsed ticks; running a task is one edge of `duration` ticks,
 * idling is a 1-tick edge. Minimizing arrival time at the full mask yields
 * the minimum makespan.
 */
import { Instance, Solution, ScheduleEntry, TickTrace } from "./model";

interface Node {
  mask: number;
  heat: number;
  time: number;
}

function key(mask: number, heat: number): string {
  return mask + ":" + heat;
}

export function solve(inst: Instance): Solution {
  const n = inst.tasks.length;
  const full = (1 << n) - 1;

  // dist[mask:heat] = earliest time reachable with that (mask, heat).
  const dist = new Map<string, number>();
  const prev = new Map<string, { pkey: string; action: string }>();

  // Simple binary-heap-free priority queue: states are few, use array + sort
  // batches. Use a proper min-heap for clarity.
  const heap: Node[] = [];
  const push = (node: Node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.time <= heap[i]!.time) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): Node | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]!.time < heap[m]!.time) m = l;
        if (r < heap.length && heap[r]!.time < heap[m]!.time) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };

  const startKey = key(0, 0);
  dist.set(startKey, 0);
  push({ mask: 0, heat: 0, time: 0 });

  let goalKey: string | null = null;

  while (heap.length > 0) {
    const cur = pop()!;
    const ck = key(cur.mask, cur.heat);
    if (dist.get(ck)! < cur.time) continue; // stale
    if (cur.mask === full) {
      goalKey = ck;
      break;
    }

    // Option 1: idle one tick (cool down).
    if (cur.time + 1 <= inst.maxTicks) {
      const nh = Math.max(0, cur.heat - inst.coolRate);
      const nk = key(cur.mask, nh);
      if (cur.time + 1 < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, cur.time + 1);
        prev.set(nk, { pkey: ck, action: "idle" });
        push({ mask: cur.mask, heat: nh, time: cur.time + 1 });
      }
    }

    // Option 2: run a pending task to completion (non-preemptive).
    for (let i = 0; i < n; i++) {
      if (cur.mask & (1 << i)) continue;
      const t = inst.tasks[i]!;
      const end = cur.time + t.duration;
      if (end > inst.maxTicks || end > t.deadline) continue;
      let h = cur.heat;
      let ok = true;
      for (let s = 0; s < t.duration; s++) {
        h += t.heat;
        if (h > inst.heatCap) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const nmask = cur.mask | (1 << i);
      const nk = key(nmask, h);
      if (end < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, end);
        prev.set(nk, { pkey: ck, action: t.id });
        push({ mask: nmask, heat: h, time: end });
      }
    }
  }

  if (goalKey === null) {
    return { feasible: false, makespan: -1, schedule: [], trace: [] };
  }

  // Reconstruct actions backwards, then build schedule + trace forwards.
  const actionsRev: string[] = [];
  let k = goalKey;
  while (k !== startKey) {
    const p = prev.get(k)!;
    actionsRev.push(p.action);
    k = p.pkey;
  }
  actionsRev.reverse();

  const schedule: ScheduleEntry[] = [];
  const trace: TickTrace[] = [];
  let time = 0;
  let heat = 0;
  const byId = new Map(inst.tasks.map((t) => [t.id, t]));
  for (const a of actionsRev) {
    if (a === "idle") {
      time += 1;
      heat = Math.max(0, heat - inst.coolRate);
      trace.push({ tick: time, action: "idle", heatAfter: heat });
    } else {
      const t = byId.get(a)!;
      const start = time + 1;
      for (let s = 0; s < t.duration; s++) {
        time += 1;
        heat += t.heat;
        trace.push({ tick: time, action: t.id, heatAfter: heat });
      }
      schedule.push({ taskId: t.id, start, end: time });
    }
  }

  return { feasible: true, makespan: time, schedule, trace };
}
