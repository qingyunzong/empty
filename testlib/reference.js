// Independent exhaustive reference implementation used to differential-test
// the production scheduler. It shares only interval utilities; constraint
// expressions are evaluated by tree-walking the AST (not the bytecode VM)
// and feasibility is decided by enumerating all legal job orderings.
import { buildWindows, subtract, maintenanceOf, maxConcurrency } from '../src/model.js';
import { durToMinutes, parseInstant } from '../src/bytecode.js';

function evalAst(e, ctx) {
  switch (e.kind) {
    case 'int': return e.v;
    case 'dur': return durToMinutes(e.v, e.unit);
    case 'instant': return parseInstant(e.v);
    case 'bool': return e.v;
    case 'call': {
      const arg = e.args[0];
      return e.name === 'overlap' ? ctx.overlap(arg.name) : ctx.total(arg.name);
    }
    case 'un': {
      const v = evalAst(e.e, ctx);
      return e.op === 'not' ? !v : -v;
    }
    case 'bin': {
      const l = evalAst(e.l, ctx);
      const r = evalAst(e.r, ctx);
      switch (e.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return Math.trunc(l / r);
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '==': return l === r;
        case '!=': return l !== r;
        case 'and': return l && r;
        case 'or': return l || r;
        default: throw new Error(`bad op ${e.op}`);
      }
    }
    default:
      throw new Error(`cannot evaluate ${e.kind}`);
  }
}

function makeCtx(byLine, lineName, cand) {
  return {
    overlap(ln) {
      const ivs = (byLine.get(ln) || []).slice();
      if (ln === lineName && cand) ivs.push(cand);
      return maxConcurrency(ivs);
    },
    total(ln) {
      let sum = 0;
      for (const iv of byLine.get(ln) || []) sum += iv.end - iv.start;
      if (ln === lineName && cand) sum += cand.end - cand.start;
      return sum;
    },
  };
}

export function feasibleReference(model) {
  const jobs = [...model.jobs.values()];
  const windows = buildWindows(model);
  const free = new Map();
  for (const [name, id] of model.lineId) {
    free.set(name, subtract(windows, maintenanceOf(model, id)));
  }
  for (const j of jobs) {
    if (!j.after.every((d) => model.jobs.has(d))) return false;
    const fits = (free.get(j.line) || []).some(([s, e]) => e - s >= j.duration);
    if (!fits) return false;
  }
  // Dependency cycle check.
  const indeg = new Map(jobs.map((j) => [j.name, 0]));
  for (const j of jobs) for (const d of j.after) indeg.set(j.name, indeg.get(j.name) + 1);
  const queue = jobs.filter((j) => indeg.get(j.name) === 0).map((j) => j.name);
  let seen = 0;
  while (queue.length) {
    const n = queue.shift();
    seen++;
    for (const j of jobs) {
      if (j.after.includes(n)) {
        indeg.set(j.name, indeg.get(j.name) - 1);
        if (indeg.get(j.name) === 0) queue.push(j.name);
      }
    }
  }
  if (seen !== jobs.length) return false;

  // Decompose into independent components: two jobs are coupled when they
  // share a constrained line or a dependency. Feasibility is the
  // conjunction of component feasibilities.
  const parent = new Map(jobs.map((j) => [j.name, j.name]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const constrainedLines = new Set();
  for (const c of model.constraints) for (const id of c.prog.linesUsed) constrainedLines.add(id);
  const jobsByLine = new Map();
  for (const j of jobs) {
    const arr = jobsByLine.get(j.line) || [];
    arr.push(j);
    jobsByLine.set(j.line, arr);
  }
  for (const [line, js] of jobsByLine) {
    if (constrainedLines.has(model.lineId.get(line))) {
      for (let k = 1; k < js.length; k++) union(js[0].name, js[k].name);
    }
  }
  for (const j of jobs) for (const d of j.after) union(j.name, d);
  const comps = new Map();
  for (const j of jobs) {
    const r = find(j.name);
    const arr = comps.get(r) || [];
    arr.push(j);
    comps.set(r, arr);
  }
  for (const comp of comps.values()) {
    if (!componentFeasible(model, comp, free)) return false;
  }
  return true;
}

function componentFeasible(model, compJobs, free) {
  const compLines = new Set(compJobs.map((j) => model.lineId.get(j.line)));
  const constraints = model.constraints.filter(
    (c) => [...c.prog.linesUsed].some((id) => compLines.has(id)),
  );
  // Necessary condition, checked once: final per-line totals are
  // placement-independent (every job must be placed), and final overlap
  // for a line with n jobs lies in 1..n. If no overlap assignment can
  // satisfy the constraints with the final totals, prune immediately.
  const sums = new Map();
  const counts = new Map();
  for (const j of compJobs) {
    const id = model.lineId.get(j.line);
    sums.set(id, (sums.get(id) || 0) + j.duration);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const refLines = new Set();
  for (const c of constraints) for (const id of c.prog.linesUsed) refLines.add(id);
  const lineIds = [...refLines];
  const ranges = lineIds.map((id) => {
    const n = counts.get(id) || 0;
    return n === 0 ? [0] : Array.from({ length: n }, (_, k) => k + 1);
  });
  let product = 1;
  for (const r of ranges) product *= r.length;
  if (constraints.length && product <= 4096) {
    let anyOk = false;
    const combo = new Array(lineIds.length).fill(0);
    const ctx = {
      overlap: (ln) => combo[lineIds.indexOf(model.lineId.get(ln))],
      total: (ln) => sums.get(model.lineId.get(ln)) || 0,
    };
    const walk = (idx) => {
      if (anyOk) return;
      if (idx === lineIds.length) {
        anyOk = constraints.every((c) => evalAst(c.ast, ctx));
        return;
      }
      for (const v of ranges[idx]) {
        combo[idx] = v;
        walk(idx + 1);
      }
    };
    walk(0);
    if (!anyOk) return false;
  }
  // Combined backtracking search: pick any ready job and any left-shifted
  // candidate start. Complete because every feasible instance admits a
  // left-shifted schedule whose starts are window starts or job ends.
  const placed = new Map();
  const byLine = new Map();
  const holds = (lineName, cand) => {
    const ctx = makeCtx(byLine, lineName, cand);
    for (const c of constraints) {
      if (!evalAst(c.ast, ctx)) return false;
    }
    return true;
  };
  function bt() {
    if (placed.size === compJobs.length) return true;
    for (const job of compJobs) {
      if (placed.has(job.name)) continue;
      if (!job.after.every((d) => placed.has(d))) continue;
      let earliest = 0;
      for (const d of job.after) earliest = Math.max(earliest, placed.get(d).end);
      const ivs = free.get(job.line) || [];
      const linePlaced = byLine.get(job.line) || [];
      const cands = new Set();
      for (const [fs, fe] of ivs) {
        const s0 = Math.max(fs, earliest);
        if (s0 + job.duration <= fe) cands.add(s0);
        for (const p of linePlaced) {
          const s = Math.max(p.end, earliest, fs);
          if (s + job.duration <= fe) cands.add(s);
        }
      }
      for (const s of [...cands].sort((a, b) => a - b)) {
        const cand = { start: s, end: s + job.duration };
        if (!holds(job.line, cand)) continue;
        placed.set(job.name, cand);
        linePlaced.push(cand);
        byLine.set(job.line, linePlaced);
        if (bt()) return true;
        linePlaced.pop();
        placed.delete(job.name);
      }
    }
    return false;
  }
  return bt();
}

// Verifies an engine placement against windows, maintenance, precedence and
// all constraints using the reference evaluator.
export function verifyPlacement(model, placed) {
  const windows = buildWindows(model);
  const byLine = new Map();
  for (const [name, p] of placed) {
    const job = model.jobs.get(name);
    const free = subtract(windows, maintenanceOf(model, model.lineId.get(job.line)));
    const inside = free.some(([s, e]) => p.start >= s && p.end <= e);
    if (!inside) return `job ${name} outside free windows`;
    for (const d of job.after) {
      if (placed.get(d).end > p.start) return `job ${name} starts before dependency ${d} ends`;
    }
    const arr = byLine.get(job.line) || [];
    arr.push({ start: p.start, end: p.end });
    byLine.set(job.line, arr);
  }
  const ctx = makeCtx(byLine, null, null);
  for (const c of model.constraints) {
    if (!evalAst(c.ast, ctx)) return `constraint violated: ${c.src}`;
  }
  return null;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
