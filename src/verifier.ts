/**
 * Independent verifier: exhaustive per-tick search over the raw machine state
 *   (completedMask, runningTask, remainingTicks, temp, time)
 * with NO dominance pruning -- only exact-state deduplication. Every
 * transition advances exactly one tick, so plain BFS layers by time give the
 * minimal makespan. This deliberately uses a different state representation
 * and transition structure from the primary solver, so agreement between the
 * two is a genuine cross-check.
 */

import type { Problem } from "./model.js";

export interface VerifyResult {
  feasible: boolean;
  makespan: number; // -1 when infeasible
  statesExplored: number;
}

export function verifyExhaustive(p: Problem): VerifyResult {
  const n = p.tasks.length;
  const full = (1 << n) - 1;

  const key = (mask: number, run: number, rem: number, temp: number, time: number): string =>
    `${mask}|${run}|${rem}|${temp}|${time}`;

  interface State { mask: number; run: number; rem: number; temp: number; time: number }
  let frontier: State[] = [{ mask: 0, run: -1, rem: 0, temp: p.initialTemp, time: 0 }];
  const seen = new Set<string>([key(0, -1, 0, p.initialTemp, 0)]);
  let explored = 0;

  while (frontier.length > 0) {
    const next: State[] = [];
    for (const s of frontier) {
      explored++;
      if (s.mask === full) return { feasible: true, makespan: s.time, statesExplored: explored };
      if (s.time >= p.maxTicks) continue;
      const t1 = s.time + 1;

      if (s.run !== -1) {
        // Continue the running task for one more tick.
        const task = p.tasks[s.run]!;
        const temp = s.temp + task.heat;
        if (temp <= p.maxTemp) {
          const rem = s.rem - 1;
          let mask = s.mask;
          let run = s.run;
          if (rem === 0) {
            if (t1 > task.deadline) continue; // misses its deadline
            mask |= 1 << s.run;
            run = -1;
          }
          const k = key(mask, run, rem, temp, t1);
          if (!seen.has(k)) {
            seen.add(k);
            next.push({ mask, run, rem, temp, time: t1 });
          }
        }
      } else {
        // Idle one tick to cool down.
        const tempIdle = Math.max(0, s.temp - p.coolingRate);
        const kIdle = key(s.mask, -1, 0, tempIdle, t1);
        if (!seen.has(kIdle)) {
          seen.add(kIdle);
          next.push({ mask: s.mask, run: -1, rem: 0, temp: tempIdle, time: t1 });
        }
        // Start any unfinished task; its first tick of work happens now.
        for (let i = 0; i < n; i++) {
          if (s.mask & (1 << i)) continue;
          const task = p.tasks[i]!;
          if (s.time + task.duration > task.deadline) continue;
          const temp = s.temp + task.heat;
          if (temp > p.maxTemp) continue;
          const rem = task.duration - 1;
          let mask = s.mask;
          let run = i;
          if (rem === 0) {
            mask |= 1 << i;
            run = -1;
          }
          const k = key(mask, run, rem, temp, t1);
          if (!seen.has(k)) {
            seen.add(k);
            next.push({ mask, run, rem, temp, time: t1 });
          }
        }
      }
    }
    frontier = next;
  }
  return { feasible: false, makespan: -1, statesExplored: explored };
}
