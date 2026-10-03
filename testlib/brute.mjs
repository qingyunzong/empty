// Reference brute-force enumerator used to validate the exact solver.
// Jobs with identical (due, work, energy, mold) parameters form a class; we
// enumerate every distinct class-level sequence (multiset permutations), keep
// every class sequence attaining the lexicographic optimum, then expand each
// into all concrete job-id schedules. This is exhaustive: no pruning.

export function bruteForce(raw) {
  const jobs = raw.jobs.map((j, i) => ({ ...j, id: j.id !== undefined ? j.id : i, mold: String(j.mold) }));
  const classOf = new Map();
  const classes = [];
  for (const j of jobs) {
    const key = JSON.stringify([j.due, j.work, j.energy, j.mold]);
    if (!classOf.has(key)) {
      classOf.set(key, classes.length);
      classes.push({ params: j, ids: [] });
    }
    classes[classOf.get(key)].ids.push(j.id);
  }
  const jobClass = jobs.map((j) => classOf.get(JSON.stringify([j.due, j.work, j.energy, j.mold])));

  const n = jobs.length;
  const k = classes.length;
  const remaining = classes.map((c) => c.ids.length);

  let best = null;
  const bestSeqs = [];
  const seq = new Array(n);

  function evaluate() {
    let time = 0;
    let energy = 0;
    let tard = 0;
    let last = null;
    for (const ci of seq) {
      const p = classes[ci].params;
      const st = last === null || last === p.mold ? 0 : raw.setup[last][p.mold];
      time += st + p.work;
      energy += st + p.energy;
      tard += Math.max(0, time - p.due);
      last = p.mold;
    }
    return [time, energy, tard];
  }

  function lexCmp(a, b) {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function gen(depth) {
    if (depth === n) {
      const obj = evaluate();
      if (obj[1] > raw.energyBudget) return; // infeasible: over energy budget
      if (best === null || lexCmp(obj, best) < 0) {
        best = obj;
        bestSeqs.length = 0;
        bestSeqs.push(seq.slice());
      } else if (lexCmp(obj, best) === 0) {
        bestSeqs.push(seq.slice());
      }
      return;
    }
    for (let c = 0; c < k; c++) {
      if (remaining[c] === 0) continue;
      remaining[c]--;
      seq[depth] = c;
      gen(depth + 1);
      remaining[c]++;
    }
  }
  gen(0);

  // Expand each optimal class sequence into all concrete id schedules.
  const schedules = new Set();
  const assigned = new Array(n);
  function expand(classSeq, classIdx, slot) {
    if (slot === n) {
      schedules.add(assigned.join(','));
      return;
    }
    const c = classSeq[slot];
    for (const id of classes[c].ids) {
      if (classIdx[c].has(id)) continue;
      classIdx[c].add(id);
      assigned[slot] = id;
      expand(classSeq, classIdx, slot + 1);
      classIdx[c].delete(id);
    }
  }
  for (const classSeq of bestSeqs) {
    expand(classSeq, classes.map(() => new Set()), 0);
  }

  return {
    objective: { makespan: best[0], energy: best[1], tardiness: best[2] },
    schedules,
    jobClass,
  };
}
