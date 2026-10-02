// Independent brute-force reference scheduler used by the test-suite to
// cross-check src/schedule.js. Deliberately written as a plain enumeration
// over all line assignments x all global job permutations.

const DAY = 1440;

function availIntervals(line, days) {
  let ints = [];
  for (let d = 0; d < days; d++) {
    for (const [s, e] of line.shifts) ints.push([d * DAY + s, d * DAY + e]);
  }
  for (const [ms, md] of line.maintenance) {
    const me = ms + md;
    ints = ints.flatMap(([s, e]) => {
      if (me <= s || ms >= e) return [[s, e]];
      const out = [];
      if (ms > s) out.push([s, ms]);
      if (me < e) out.push([me, e]);
      return out;
    });
  }
  return ints.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
}

function placeOrder(orderedJobs, intervals) {
  const starts = [];
  let ii = 0;
  let earliest = 0;
  for (const job of orderedJobs) {
    let st = -1;
    while (ii < intervals.length) {
      const [s, e] = intervals[ii];
      const cand = Math.max(earliest, s);
      if (cand + job.duration <= e) { st = cand; break; }
      ii++;
    }
    if (st < 0) return null;
    starts.push(st);
    earliest = st + job.duration;
  }
  return starts;
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* assignments(eligible, k = 0, acc = []) {
  if (k === eligible.length) { yield acc.slice(); return; }
  for (const li of eligible[k]) {
    acc.push(li);
    yield* assignments(eligible, k + 1, acc);
    acc.pop();
  }
}

// jobs: [{ id, duration, priority, lines: [name] | null }]; lines: [{ name, shifts, maintenance }]
// horizonDays: caller-provided (tests reuse the production horizon for fairness).
// Returns { wct, makespan, placement: Map id -> {line, start} } or null.
export function bruteForce(jobs, lines, horizonDays) {
  const sorted = [...jobs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const intervals = lines.map((l) => availIntervals(l, horizonDays));
  const lineIdx = new Map(lines.map((l, i) => [l.name, i]));
  const eligible = sorted.map((j) =>
    (j.lines ?? lines.map((l) => l.name)).map((n) => lineIdx.get(n)).filter((i) => i !== undefined));
  if (eligible.some((e) => e.length === 0)) return null;

  let best = null;
  const consider = (wct, makespan, placement) => {
    const vec = [];
    for (const j of sorted) {
      const p = placement.get(j.id);
      vec.push(p.line, p.start);
    }
    const cand = { wct, makespan, vec, placement };
    if (best === null) { best = cand; return; }
    if (cand.wct !== best.wct) { if (cand.wct < best.wct) best = cand; return; }
    if (cand.makespan !== best.makespan) { if (cand.makespan < best.makespan) best = cand; return; }
    for (let i = 0; i < cand.vec.length; i++) {
      if (cand.vec[i] !== best.vec[i]) {
        if (cand.vec[i] < best.vec[i]) best = cand;
        return;
      }
    }
  };

  for (const assign of assignments(eligible)) {
    for (const perm of permutations(sorted)) {
      // per-line ordered sequences from the global permutation
      const orderedByLine = lines.map((_, li) => perm.filter((j) => assign[sorted.indexOf(j)] === li));
      const placement = new Map();
      let wct = 0;
      let makespan = 0;
      let ok = true;
      for (let li = 0; li < lines.length; li++) {
        const starts = placeOrder(orderedByLine[li], intervals[li]);
        if (starts === null) { ok = false; break; }
        for (let k = 0; k < orderedByLine[li].length; k++) {
          const job = orderedByLine[li][k];
          const completion = starts[k] + job.duration;
          wct += job.priority * completion;
          if (completion > makespan) makespan = completion;
          placement.set(job.id, { line: li, start: starts[k] });
        }
      }
      if (ok) consider(wct, makespan, placement);
    }
  }
  return best;
}
