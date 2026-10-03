export const DEFAULTS = {
  changeoverMin: 30 * 60_000,
  horizonHours: 8,
  exactLimit: 9,
  maxSchedules: 500,
};

const MIN_MS = 60_000;

export function mergeBlocked(intervals) {
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function fit(t, dur, blocked) {
  for (const [s, e] of blocked) {
    if (e <= t) continue;
    if (s >= t + dur) break;
    t = e;
  }
  return t;
}

export function simulate(sequence, jobs, blocked, t0, changeoverMin) {
  let t = t0;
  let mold = null;
  let energy = 0;
  const placed = [];
  for (const id of sequence) {
    const job = jobs.get(id);
    let changeover = null;
    if (mold !== job.mold) {
      const cs = fit(t, changeoverMin, blocked);
      changeover = { start: cs, end: cs + changeoverMin };
      t = cs + changeoverMin;
      energy += 1;
      mold = job.mold;
    }
    const dur = job.qty * job.op * MIN_MS;
    const start = fit(t, dur, blocked);
    const end = start + dur;
    placed.push({ job: id, mold: job.mold, changeover, start, end });
    t = end;
  }
  const tardy = placed.reduce((n, p) => n + (p.end > jobs.get(p.job).due ? 1 : 0), 0);
  return { placed, makespan: t, energy, tardy };
}

function compareObj(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function lexCmpSeq(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

export function* permutations(items) {
  const a = items.slice();
  const n = a.length;
  const c = new Array(n).fill(0);
  if (n > 0) yield a.slice();
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      const tmp = a[j]; a[j] = a[i]; a[i] = tmp;
      yield a.slice();
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

export function optimize(jobs, blockedIntervals, t0, opts = {}) {
  const changeoverMin = opts.changeoverMin ?? DEFAULTS.changeoverMin;
  const exactLimit = opts.exactLimit ?? DEFAULTS.exactLimit;
  const maxSchedules = opts.maxSchedules ?? DEFAULTS.maxSchedules;
  const blocked = mergeBlocked(blockedIntervals);
  const ids = [...jobs.keys()].sort();
  const empty = { t0, objective: null, schedules: [], totalOptimal: 0, truncated: false, exact: true };
  if (ids.length === 0) return empty;

  let bestObj = null;
  let ties = [];
  let total = 0;
  const consider = (seq) => {
    const r = simulate(seq, jobs, blocked, t0, changeoverMin);
    const obj = [r.tardy, r.makespan, r.energy];
    if (bestObj === null || compareObj(obj, bestObj) < 0) {
      bestObj = obj;
      ties = [r];
      total = 1;
    } else if (compareObj(obj, bestObj) === 0) {
      total += 1;
      if (ties.length < maxSchedules) ties.push(r);
    }
  };

  let exact = true;
  if (ids.length <= exactLimit) {
    for (const p of permutations(ids)) consider(p);
  } else {
    exact = false;
    const seq = ids.slice().sort((x, y) => {
      const d = jobs.get(x).due - jobs.get(y).due;
      return d !== 0 ? d : lexCmpSeq([x], [y]);
    });
    consider(seq);
  }

  ties.sort((a, b) => lexCmpSeq(a.placed.map((p) => p.job), b.placed.map((p) => p.job)));
  return {
    t0,
    objective: { tardy: bestObj[0], makespan: bestObj[1], energy: bestObj[2] },
    schedules: ties.map((r) => r.placed),
    totalOptimal: total,
    truncated: total > ties.length,
    exact,
  };
}
