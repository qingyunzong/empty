// Independent reference: plain discrete-time enumeration of every partition
// and every integer start-time tuple within a makespan bound. Used by tests to
// cross-check the branch-and-bound solver.
import { EPS, compileCurve } from './curve.js';
import { runFeasible, runProfile, scheduleStats, maxClosedPower } from './model.js';
import { cmpObjective } from './solver.js';

export function enumerateOptimal(batchList, config, makespanBound) {
  const batches = batchList.map((b) => ({ ...b, compiled: compileCurve(b.curve) }));
  const n = batches.length;
  let best = null;
  let count = 0;
  const schedules = [];
  const blocks = [];

  function snapshot(starts) {
    const runs = blocks
      .map((blk, bi) => ({ start: starts[bi], batches: blk.map((i) => batches[i].id).sort() }))
      .sort((a, b) => a.start - b.start || (a.batches[0] < b.batches[0] ? -1 : 1));
    return { runs };
  }

  function recStarts(profiles, pos, placed, starts, curMakespan) {
    if (pos === profiles.length) {
      const stats = scheduleStats(placed);
      const obj = [stats.makespan, stats.max - stats.min, profiles.length];
      const c = best ? cmpObjective(obj, best) : -1;
      if (c < 0) {
        best = obj;
        count = 1;
        schedules.length = 0;
        schedules.push(snapshot(starts));
      } else if (c === 0) {
        count++;
        schedules.push(snapshot(starts));
      }
      return;
    }
    const prof = profiles[pos];
    const latest = Math.floor(makespanBound - prof.duration + EPS);
    for (let s = 0; s <= latest; s++) {
      const end = s + prof.duration;
      if (Math.max(curMakespan, end) > makespanBound + EPS) continue;
      starts[pos] = s;
      placed.push({ profile: prof, start: s });
      if (maxClosedPower(placed) <= config.peakLimit + EPS) {
        recStarts(profiles, pos + 1, placed, starts, Math.max(curMakespan, end));
      }
      placed.pop();
    }
  }

  (function rec(i) {
    if (i === n) {
      const profiles = blocks.map((blk) => runProfile(blk, batches));
      recStarts(profiles, 0, [], new Array(blocks.length).fill(0), 0);
      return;
    }
    for (let bi = 0; bi < blocks.length; bi++) {
      blocks[bi].push(i);
      if (runFeasible(blocks[bi], batches, config)) rec(i + 1);
      blocks[bi].pop();
    }
    blocks.push([i]);
    if (runFeasible(blocks[blocks.length - 1], batches, config)) rec(i + 1);
    blocks.pop();
  })(0);

  return {
    objective: best ? { makespan: best[0], peakValley: best[1], runs: best[2] } : null,
    count,
    schedules,
  };
}
