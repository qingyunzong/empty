/**
 * Independent exhaustive permutation enumerator (with safe bound pruning)
 * used to cross-check the DP solver. Keeps every tied optimal sequence.
 * Objective: lexicographic (makespan, energy, tardiness).
 */
export function bruteForce(instance, options = {}) {
  const maxSolutions = options.maxSolutions ?? 1000000;
  const { jobs, setup, energyBudget } = instance;
  const n = jobs.length;

  let best = null;
  const solutions = [];
  let truncated = false;
  let nodes = 0;
  let leaves = 0;

  const used = new Array(n).fill(false);
  const seq = [];
  let time = 0;
  let energy = 0;
  let tardiness = 0;
  let lastJob = -1;
  let workDone = 0;
  const totalWork = jobs.reduce((a, j) => a + j.work, 0);

  const isBetter = (t, e, td) =>
    t < best.time ||
    (t === best.time && (e < best.energy || (e === best.energy && td < best.tardiness)));
  const isEqual = (t, e, td) => t === best.time && e === best.energy && td === best.tardiness;

  function dfs() {
    nodes++;
    if (seq.length === n) {
      leaves++;
      if (best === null || isBetter(time, energy, tardiness)) {
        best = { time, energy, tardiness };
        solutions.length = 0;
        solutions.push(seq.map((i) => jobs[i].id));
      } else if (isEqual(time, energy, tardiness)) {
        if (solutions.length < maxSolutions) solutions.push(seq.map((i) => jobs[i].id));
        else truncated = true;
      }
      return;
    }
    // Bound pruning: partial (time, tardiness) can only grow, so a partial
    // state already lexicographically worse than the best final can be cut.
    // The remaining-work lower bound strengthens the makespan cut.
    if (best !== null) {
      const minFinalTime = time + (totalWork - workDone);
      if (minFinalTime > best.time) return;
      if (minFinalTime === best.time && tardiness > best.tardiness) return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const job = jobs[j];
      const e2 = energy + job.energy;
      if (e2 > energyBudget) continue; // energy budget pruning
      const t2 = time + (lastJob < 0 ? 0 : setup[jobs[lastJob].moldIdx][job.moldIdx]) + job.work;
      const td2 = tardiness + Math.max(0, t2 - job.due);
      used[j] = true;
      seq.push(j);
      const saved = [time, energy, tardiness, lastJob, workDone];
      time = t2; energy = e2; tardiness = td2; lastJob = j; workDone += job.work;
      dfs();
      [time, energy, tardiness, lastJob, workDone] = saved;
      seq.pop();
      used[j] = false;
    }
  }
  dfs();

  if (best === null) return { status: 'UNSAT', stats: { nodes, leaves } };
  return {
    status: 'FEASIBLE',
    objective: { makespan: best.time, energy: best.energy, tardiness: best.tardiness },
    solutions,
    truncated,
    stats: { nodes, leaves },
  };
}
