/**
 * Independent verifier: exhaustive per-tick breadth-first search over the
 * complete state space (tick, heat, doneMask, runningTask, remainingTicks).
 * Written deliberately differently from the Dijkstra solver: it expands one
 * tick at a time and tracks every reachable state, so the first tick at
 * which the full mask appears is the provable minimum makespan.
 */
import { Instance } from "./model";

export function bruteForceMakespan(inst: Instance): number {
  const n = inst.tasks.length;
  const full = (1 << n) - 1;

  // State encoding for the visited set.
  // running = -1 means the machine is free.
  const encode = (
    heat: number,
    mask: number,
    running: number,
    remaining: number,
  ): string => `${heat}|${mask}|${running}|${remaining}`;

  interface State {
    heat: number;
    mask: number;
    running: number; // task index or -1
    remaining: number; // ticks left of the running task (after this tick)
  }

  let frontier: State[] = [{ heat: 0, mask: 0, running: -1, remaining: 0 }];

  if (full === 0) return 0;

  for (let tick = 1; tick <= inst.maxTicks; tick++) {
    const next: State[] = [];
    const nextVisited = new Set<string>();
    const consider = (s: State) => {
      const k = encode(s.heat, s.mask, s.running, s.remaining);
      if (nextVisited.has(k)) return;
      nextVisited.add(k);
      next.push(s);
    };

    for (const s of frontier) {
      if (s.running >= 0) {
        // Non-preemptive: a running task must continue this tick.
        const t = inst.tasks[s.running]!;
        const h = s.heat + t.heat;
        if (h > inst.heatCap) continue; // state dies: overheated
        const rem = s.remaining - 1;
        if (rem === 0) {
          if (tick > t.deadline) continue; // missed deadline
          consider({
            heat: h,
            mask: s.mask | (1 << s.running),
            running: -1,
            remaining: 0,
          });
        } else {
          consider({ heat: h, mask: s.mask, running: s.running, remaining: rem });
        }
        continue;
      }

      // Machine free: option A, idle (cool down).
      consider({
        heat: Math.max(0, s.heat - inst.coolRate),
        mask: s.mask,
        running: -1,
        remaining: 0,
      });

      // Option B: start any pending task (occupies this tick).
      for (let i = 0; i < n; i++) {
        if (s.mask & (1 << i)) continue;
        const t = inst.tasks[i]!;
        const h = s.heat + t.heat;
        if (h > inst.heatCap) continue;
        if (t.duration === 1) {
          if (tick > t.deadline) continue;
          consider({ heat: h, mask: s.mask | (1 << i), running: -1, remaining: 0 });
        } else {
          consider({ heat: h, mask: s.mask, running: i, remaining: t.duration - 1 });
        }
      }
    }

    for (const s of next) {
      if (s.mask === full) return tick;
    }
    frontier = next;
    if (frontier.length === 0) return -1;
  }
  return -1;
}
