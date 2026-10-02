// Scheduler: assigns each job a line and a start time (minutes since 2026-01-01T00:00Z).
// Jobs must fit inside a single availability interval (shift windows minus maintenance).
// Objective: minimize sum(priority * completion), then makespan, then a deterministic
// lexicographic tie-break on (line, start) per job id so equal priorities are stable.
// Exact enumeration is used when the search space is small enough; otherwise a greedy
// list scheduler is used.

const DAY = 1440;
const MAX_EXACT_LEAVES = 2_000_000;

export function buildIntervals(line, horizonDays) {
  let ints = [];
  for (let d = 0; d < horizonDays; d++) {
    for (const [s, e] of line.shifts) ints.push([d * DAY + s, d * DAY + e]);
  }
  for (const [ms, md] of line.maintenance) {
    const me = ms + md;
    const next = [];
    for (const [s, e] of ints) {
      if (me <= s || ms >= e) { next.push([s, e]); continue; }
      if (ms > s) next.push([s, ms]);
      if (me < e) next.push([me, e]);
    }
    ints = next;
  }
  return ints.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
}

export function computeHorizon(jobs, lines) {
  const total = jobs.reduce((a, j) => a + j.duration, 0);
  const daily = lines
    .map((l) => l.shifts.reduce((a, [s, e]) => a + (e - s), 0))
    .filter((x) => x > 0);
  const minDaily = daily.length ? Math.min(...daily) : DAY / 2;
  const maintDays = lines.reduce((a, l) => a + l.maintenance.length, 0);
  const days = Math.ceil(total / minDaily) + maintDays + 2;
  return Math.min(Math.max(days, 1), 400);
}

// Place a sequence of jobs at their earliest feasible starts on one line.
// Returns array of starts or null if the sequence does not fit.
function decodeLine(seq, intervals) {
  const starts = new Array(seq.length);
  let ii = 0;
  let cur = 0;
  for (let k = 0; k < seq.length; k++) {
    const dur = seq[k].duration;
    let placed = -1;
    while (ii < intervals.length) {
      const [s, e] = intervals[ii];
      const st = Math.max(cur, s);
      if (st + dur <= e) { placed = st; break; }
      ii++;
    }
    if (placed < 0) return null;
    starts[k] = placed;
    cur = placed + dur;
  }
  return starts;
}

function costOf(sortedJobs, seqs, intervals) {
  // returns { wct, makespan, vec, placement } or null
  const placement = new Map();
  let wct = 0;
  let makespan = 0;
  for (let li = 0; li < seqs.length; li++) {
    const starts = decodeLine(seqs[li], intervals[li]);
    if (starts === null) return null;
    for (let k = 0; k < seqs[li].length; k++) {
      const job = seqs[li][k];
      const completion = starts[k] + job.duration;
      wct += job.priority * completion;
      if (completion > makespan) makespan = completion;
      placement.set(job.id, { line: li, start: starts[k] });
    }
  }
  const vec = [];
  for (const j of sortedJobs) {
    const p = placement.get(j.id);
    vec.push(p.line, p.start);
  }
  return { wct, makespan, vec, placement };
}

function strictlyBetter(a, b) {
  if (b === null) return true;
  if (a.wct !== b.wct) return a.wct < b.wct;
  if (a.makespan !== b.makespan) return a.makespan < b.makespan;
  for (let i = 0; i < a.vec.length; i++) {
    if (a.vec[i] !== b.vec[i]) return a.vec[i] < b.vec[i];
  }
  return false;
}

function exactSearch(sortedJobs, eligible, intervals) {
  const seqs = intervals.map(() => []);
  let best = null;
  function rec(i) {
    if (i === sortedJobs.length) {
      const cand = costOf(sortedJobs, seqs, intervals);
      if (cand && strictlyBetter(cand, best)) best = cand;
      return;
    }
    const job = sortedJobs[i];
    for (const li of eligible[i]) {
      const seq = seqs[li];
      for (let pos = 0; pos <= seq.length; pos++) {
        seq.splice(pos, 0, job);
        rec(i + 1);
        seq.splice(pos, 1);
      }
    }
  }
  rec(0);
  return best;
}

function earliestSlot(ints, busy, dur) {
  for (const [s, e] of ints) {
    let cur = s;
    for (const [bs, be] of busy) {
      if (be <= cur) continue;
      if (bs >= e) break;
      if (bs > cur && bs - cur >= dur) return cur;
      if (be > cur) cur = be;
      if (cur >= e) break;
    }
    if (e - cur >= dur) return cur;
  }
  return -1;
}

function greedySearch(jobs, eligible, intervals) {
  const order = jobs
    .map((j, i) => [j, i])
    .sort((a, b) => b[0].priority - a[0].priority || (a[0].id < b[0].id ? -1 : 1));
  const busy = intervals.map(() => []);
  const placement = new Map();
  for (const [job, i] of order) {
    let bestLi = -1;
    let bestStart = -1;
    for (const li of eligible[i]) {
      const st = earliestSlot(intervals[li], busy[li], job.duration);
      if (st < 0) continue;
      if (bestStart < 0 || st < bestStart || (st === bestStart && li < bestLi)) {
        bestStart = st;
        bestLi = li;
      }
    }
    if (bestLi < 0) return null;
    const list = busy[bestLi];
    const entry = [bestStart, bestStart + job.duration];
    let at = list.length;
    while (at > 0 && list[at - 1][0] > entry[0]) at--;
    list.splice(at, 0, entry);
    placement.set(job.id, { line: bestLi, start: bestStart });
  }
  return { placement };
}

// jobs: [{ id, duration, priority, lines: [name] | null }]
// lines: [{ name, shifts: [[s,e]...], maintenance: [[start,dur]...] }]
// Returns { placement: Map id -> { line: lineIndex, start } } or null if infeasible.
export function scheduleJobs(jobs, lines) {
  if (jobs.length === 0) return { placement: new Map() };
  const sorted = [...jobs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const horizon = computeHorizon(sorted, lines);
  const intervals = lines.map((l) => buildIntervals(l, horizon));
  const lineIdx = new Map(lines.map((l, i) => [l.name, i]));
  const eligible = sorted.map((j) => {
    const names = j.lines ?? lines.map((l) => l.name);
    return names.map((n) => lineIdx.get(n)).filter((i) => i !== undefined);
  });
  if (eligible.some((e) => e.length === 0)) return null;

  let leaves = 1;
  for (let i = 0; i < sorted.length; i++) {
    leaves *= i + eligible[i].length;
    if (leaves > MAX_EXACT_LEAVES) break;
  }
  if (leaves > MAX_EXACT_LEAVES) return greedySearch(sorted, eligible, intervals);
  const best = exactSearch(sorted, eligible, intervals);
  return best ? { placement: best.placement } : null;
}
