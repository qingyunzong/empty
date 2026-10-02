import { createHash } from 'node:crypto';

export const ERR_WINDOW = 'ERR_WINDOW';
export const ERR_LOCK = 'ERR_LOCK';

const DEFAULT_NODE_LIMIT = 5_000_000;
const DEFAULT_MAX_SOLUTIONS = 100_000;

export function validateInstance(instance) {
  if (!instance || !Array.isArray(instance.orders) || !Array.isArray(instance.techs) || !Array.isArray(instance.kits)) {
    const err = new Error('instance must provide orders, techs and kits arrays');
    err.code = 'ERR_INPUT';
    throw err;
  }
  for (const order of instance.orders) {
    const [ws, we] = order.window;
    if (we < ws) {
      const err = new Error(`order ${order.id}: window end ${we} is earlier than start ${ws}`);
      err.code = ERR_WINDOW;
      err.order = order.id;
      throw err;
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(obj) {
  return createHash('sha256').update(canonical(obj)).digest('hex');
}

// Bipartite feasibility: can every demanded part unit be served by a kit unit
// whose `compatible` list contains that part type? (kit units are identical per kit)
export function kitsSuffice(kits, demandParts) {
  const units = [...demandParts];
  const slots = [];
  kits.forEach((kit, ki) => {
    for (let i = 0; i < kit.qty; i++) slots.push(ki);
  });
  const matchSlot = new Array(slots.length).fill(-1);
  function tryAssign(ui, seen) {
    const part = units[ui];
    for (let s = 0; s < slots.length; s++) {
      if (seen[s]) continue;
      if (!kits[slots[s]].compatible.includes(part)) continue;
      seen[s] = true;
      if (matchSlot[s] === -1 || tryAssign(matchSlot[s], seen)) {
        matchSlot[s] = ui;
        return true;
      }
    }
    return false;
  }
  for (let u = 0; u < units.length; u++) {
    if (!tryAssign(u, new Array(slots.length).fill(false))) return false;
  }
  return true;
}

const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

// Exact branch-and-bound over lexicographic objective:
//   1. maximize completed orders
//   2. minimize overtime (slots worked past shift end)
//   3. minimize skill switches per tech timeline
// Enumerates every solution tied at the optimum.
export function solve(instance, options = {}) {
  validateInstance(instance);
  const nodeLimit = options.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const maxSolutions = options.maxSolutions ?? DEFAULT_MAX_SOLUTIONS;
  const { orders, techs, kits } = instance;
  const locks = options.locks ?? [];

  const placementsByTech = techs.map(() => []);
  const placed = []; // all placements (locked + decided), for kit coupling
  const lockedAssignments = [];
  let baseOvertime = 0;
  let lockedCount = 0;

  const techFree = (ti, s, e) => placementsByTech[ti].every((p) => !overlaps(s, e, p.start, p.end));

  function kitsOk(s, e, parts) {
    const pts = new Set([s, e]);
    for (const p of placed) {
      if (overlaps(s, e, p.start, p.end)) {
        pts.add(Math.max(p.start, s));
        pts.add(Math.min(p.end, e));
      }
    }
    const sorted = [...pts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const segS = sorted[i];
      const segE = sorted[i + 1];
      if (segS >= segE) continue;
      const demand = [...parts];
      for (const p of placed) {
        if (p.start < segE && segS < p.end) demand.push(...p.parts);
      }
      if (!kitsSuffice(kits, demand)) return false;
    }
    return true;
  }

  // Apply locks first: they consume shift/kit resources before the search.
  const lockedIds = new Set();
  for (const lock of locks) {
    const order = orders.find((o) => o.id === lock.order);
    if (!order) return { status: ERR_LOCK, error: `unknown order ${lock.order}` };
    const ti = techs.findIndex((t) => t.id === lock.tech);
    if (ti === -1) return { status: ERR_LOCK, error: `unknown tech ${lock.tech}` };
    const tech = techs[ti];
    if (!tech.skills.includes(order.skill)) {
      return { status: ERR_LOCK, error: `tech ${lock.tech} lacks skill ${order.skill}`, order: order.id };
    }
    const s = lock.start;
    const e = s + order.duration;
    const [ws, we] = order.window;
    if (s < ws || e > we) {
      return { status: ERR_LOCK, error: `lock outside window [${ws},${we})`, order: order.id };
    }
    const shift = tech.shifts.find(([ss, se]) => s >= ss && s < se);
    if (!shift) return { status: ERR_LOCK, error: 'lock starts outside any shift', order: order.id };
    if (!techFree(ti, s, e) || !kitsOk(s, e, order.parts)) {
      return { status: ERR_LOCK, error: 'lock conflicts with another locked assignment', order: order.id };
    }
    const overtime = Math.max(0, e - shift[1]);
    placementsByTech[ti].push({ order: order.id, skill: order.skill, start: s, end: e });
    placed.push({ start: s, end: e, parts: order.parts });
    lockedAssignments.push({ order: order.id, tech: tech.id, start: s, end: e, overtime, locked: true });
    baseOvertime += overtime;
    lockedCount++;
    lockedIds.add(order.id);
  }

  const freeOrders = orders.filter((o) => !lockedIds.has(o.id));

  // Candidate placements per order: start inside a shift, finish inside window.
  const optionsPerOrder = freeOrders.map((order) => {
    const opts = [];
    const seen = new Set();
    techs.forEach((tech, ti) => {
      if (!tech.skills.includes(order.skill)) return;
      for (const [ss, se] of tech.shifts) {
        const lo = Math.max(order.window[0], ss);
        const hi = Math.min(order.window[1] - order.duration, se - 1);
        for (let t = lo; t <= hi; t++) {
          const key = `${ti}:${t}`;
          if (seen.has(key)) continue;
          seen.add(key);
          opts.push({ tech: ti, start: t, end: t + order.duration, overtime: Math.max(0, t + order.duration - se) });
        }
      }
    });
    return opts;
  });

  let best = null;
  let solutions = [];
  let nodes = 0;
  let aborted = false;
  let truncated = false;
  const current = new Array(freeOrders.length).fill(null);

  const better = (a, b) =>
    a.completed !== b.completed ? a.completed > b.completed
    : a.overtime !== b.overtime ? a.overtime < b.overtime
    : a.switches < b.switches;

  function computeSwitches() {
    let sw = 0;
    for (const list of placementsByTech) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].skill !== sorted[i - 1].skill) sw++;
      }
    }
    return sw;
  }

  function snapshot() {
    return [...lockedAssignments, ...current.filter(Boolean)]
      .map((a) => ({ ...a }))
      .sort((a, b) => String(a.order).localeCompare(String(b.order), undefined, { numeric: true }));
  }

  function dfs(i, completed, overtime) {
    if (aborted || truncated) return;
    if (++nodes > nodeLimit) { aborted = true; return; }
    if (best) {
      const remaining = freeOrders.length - i;
      // `best` is stored in total terms (locked included); compare in free terms.
      const bestFreeCompleted = best.completed - lockedCount;
      const bestFreeOvertime = best.overtime - baseOvertime;
      if (completed + remaining < bestFreeCompleted) return;
      if (completed + remaining === bestFreeCompleted && overtime > bestFreeOvertime) return;
    }
    if (i === freeOrders.length) {
      const vec = {
        completed: completed + lockedCount,
        overtime: overtime + baseOvertime,
        switches: computeSwitches(),
      };
      if (!best || better(vec, best)) {
        best = vec;
        solutions = [snapshot()];
      } else if (vec.completed === best.completed && vec.overtime === best.overtime && vec.switches === best.switches) {
        if (solutions.length >= maxSolutions) { truncated = true; return; }
        solutions.push(snapshot());
      }
      return;
    }
    const order = freeOrders[i];
    for (const opt of optionsPerOrder[i]) {
      if (!techFree(opt.tech, opt.start, opt.end)) continue;
      if (!kitsOk(opt.start, opt.end, order.parts)) continue;
      placementsByTech[opt.tech].push({ order: order.id, skill: order.skill, start: opt.start, end: opt.end });
      placed.push({ start: opt.start, end: opt.end, parts: order.parts });
      current[i] = { order: order.id, tech: techs[opt.tech].id, start: opt.start, end: opt.end, overtime: opt.overtime };
      dfs(i + 1, completed + 1, overtime + opt.overtime);
      current[i] = null;
      placed.pop();
      placementsByTech[opt.tech].pop();
    }
    dfs(i + 1, completed, overtime); // leave order unassigned
  }

  dfs(0, 0, 0);

  if (aborted) {
    // UNKNOWN is not a proof of infeasibility.
    return { status: 'UNKNOWN', nodes, objective: null, optimalCount: 0, assignments: [], solutions: [] };
  }
  return {
    status: 'OPTIMAL',
    nodes,
    objective: { ...best, total: orders.length },
    optimalCount: solutions.length,
    assignments: solutions[0] ?? [],
    solutions,
    truncated,
  };
}

function subInstance(instance, idxs) {
  return { ...instance, orders: idxs.map((i) => instance.orders[i]) };
}

// Necessary-condition bottleneck analysis over a subset of orders.
function findBottleneck(instance, subsetIdxs) {
  const orders = subsetIdxs.map((i) => instance.orders[i]);
  // 1) kit shortage at a forced-concurrency point (window overlap)
  const points = [...new Set(orders.map((o) => o.window[0]))].sort((a, b) => a - b);
  for (const t of points) {
    const active = orders.filter((o) => o.window[0] <= t && t < o.window[1]);
    const demand = active.flatMap((o) => o.parts);
    if (demand.length > 0 && !kitsSuffice(instance.kits, demand)) {
      const counts = {};
      for (const p of demand) counts[p] = (counts[p] || 0) + 1;
      const partTypes = Object.keys(counts);
      return {
        type: 'kit',
        time: t,
        demand: counts,
        kits: instance.kits
          .filter((k) => k.compatible.some((p) => partTypes.includes(p)))
          .map((k) => ({ id: k.id, qty: k.qty, compatible: k.compatible })),
      };
    }
  }
  // 2) shift capacity per skill
  for (const skill of [...new Set(orders.map((o) => o.skill))]) {
    const demand = orders.filter((o) => o.skill === skill).reduce((a, o) => a + o.duration, 0);
    const capacity = instance.techs
      .filter((t) => t.skills.includes(skill))
      .reduce((a, t) => a + t.shifts.reduce((x, [s, e]) => x + (e - s), 0), 0);
    if (demand > capacity) return { type: 'shift', skill, demand, capacity };
  }
  return { type: 'schedule', note: 'combinatorial conflict; no single-resource bottleneck' };
}

// Minimal conflict certificate: smallest order subset that still cannot be
// completed in full (deletion-minimal), plus the resource bottleneck.
export function buildCertificate(instance, options = {}) {
  validateInstance(instance);
  const nodeLimit = options.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const full = solve(instance, { nodeLimit });
  if (full.status === 'UNKNOWN') return { status: 'UNKNOWN' };
  if (full.objective.completed === instance.orders.length) return { status: 'FEASIBLE' };

  let subset = instance.orders.map((_, i) => i);
  for (const idx of [...subset]) {
    const trial = subset.filter((x) => x !== idx);
    const r = solve(subInstance(instance, trial), { nodeLimit });
    if (r.status === 'UNKNOWN') return { status: 'UNKNOWN' };
    if (r.objective.completed < trial.length) subset = trial;
  }

  const certificate = {
    type: 'MINIMAL_CONFLICT',
    orders: subset.map((i) => instance.orders[i].id).sort(),
    bottleneck: findBottleneck(instance, subset),
  };
  certificate.hash = hashObject(certificate);
  return { status: 'INFEASIBLE', certificate };
}

// Re-verifiable: subset infeasible, every proper single-removal feasible, hash intact.
export function verifyCertificate(instance, certificate, options = {}) {
  const nodeLimit = options.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const checks = [];
  const ids = certificate.orders;
  const inSubset = (o) => ids.includes(o.id);

  const whole = solve({ ...instance, orders: instance.orders.filter(inSubset) }, { nodeLimit });
  if (whole.status === 'UNKNOWN') return { valid: false, status: 'UNKNOWN', checks };
  checks.push({ check: 'subset-infeasible', pass: whole.objective.completed < ids.length });

  for (const id of ids) {
    const rest = solve({ ...instance, orders: instance.orders.filter((o) => inSubset(o) && o.id !== id) }, { nodeLimit });
    if (rest.status === 'UNKNOWN') return { valid: false, status: 'UNKNOWN', checks };
    checks.push({ check: `minimal:remove-${id}`, pass: rest.objective.completed === ids.length - 1 });
  }

  const { hash, ...body } = certificate;
  checks.push({ check: 'hash', pass: hashObject(body) === hash });
  return { valid: checks.every((c) => c.pass), status: 'INFEASIBLE', checks };
}

// Top-level entry: solve, then attach a minimal conflict certificate when not
// every order could be completed.
export function plan(instance, options = {}) {
  const result = solve(instance, options);
  if (result.status !== 'OPTIMAL') return result;
  const out = { ...result };
  if (options.requireAll && result.objective.completed < instance.orders.length) {
    out.status = 'INFEASIBLE';
  }
  if (result.objective.completed < instance.orders.length) {
    const cert = buildCertificate(instance, options);
    out.certificateStatus = cert.status;
    if (cert.certificate) {
      out.certificate = cert.certificate;
      out.certificateHash = cert.certificate.hash;
    }
  }
  return out;
}
