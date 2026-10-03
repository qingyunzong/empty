import { canon, sha256hex, GENESIS } from './canon.js';
import { validateInstance, indexInstance } from './instance.js';
import { placeOne, unplaceOne } from './schedule.js';
import { invalidInput } from './errors.js';

// Hash-chained certificate writer with a byte budget.
export class CertWriter {
  constructor({ prevHash = GENESIS, seqStart = 0, maxBytes = null } = {}) {
    this.entries = [];
    this.prev = prevHash;
    this.seq = seqStart;
    this.maxBytes = maxBytes === null || maxBytes === undefined ? Infinity : maxBytes;
    this.size = 2; // canonical "[]"
    this.overflow = false;
  }
  push(entry) {
    if (this.overflow) return false;
    const e = { seq: this.seq, prev: this.prev, entry };
    e.hash = sha256hex(e.prev + '\n' + canon(entry));
    const s = canon(e);
    const newSize = this.entries.length === 0 ? this.size + s.length : this.size + 1 + s.length;
    if (newSize > this.maxBytes) {
      this.overflow = true;
      return false;
    }
    this.size = newSize;
    this.entries.push(e);
    this.prev = e.hash;
    this.seq++;
    return true;
  }
}

function betterThan(candidate, best) {
  if (!best) return true;
  if (candidate.makespan !== best.makespan) return candidate.makespan < best.makespan;
  return candidate.key < best.key;
}

// Deterministic branch-and-bound solver.
// options: { pins, maxNodes, maxCertBytes, prevHash, seqStart }
// Returns { status, plan|null, entries, nodes, head }.
// status: SAT | UNSAT | PENDING (PENDING only on budget exhaustion).
export function solve(rawInst, options = {}) {
  const inst = validateInstance(rawInst);
  const idx = indexInstance(inst);
  const pins = options.pins ?? {};
  const maxNodes = options.maxNodes ?? Infinity;
  const writer = new CertWriter({
    prevHash: options.prevHash ?? GENESIS,
    seqStart: options.seqStart ?? 0,
    maxBytes: options.maxCertBytes ?? null,
  });

  for (const [step, value] of Object.entries(pins)) {
    const s = idx.byId.get(step);
    if (!s) throw invalidInput(`pin references unknown step ${JSON.stringify(step)}`);
    if (!s.params.includes(value)) {
      throw invalidInput(`pin value ${JSON.stringify(value)} not in domain of step ${JSON.stringify(step)}`);
    }
  }

  const instanceHash = sha256hex(canon(inst));
  writer.push({
    type: 'init',
    instance: instanceHash,
    pins,
    budgets: {
      maxNodes: maxNodes === Infinity ? null : maxNodes,
      maxCertBytes: writer.maxBytes === Infinity ? null : writer.maxBytes,
    },
  });

  const domains = new Map(inst.steps.map((s) => [s.id, [...s.params].sort()]));
  const assigned = new Map();
  const placed = new Map();
  const machineIntervals = Array.from({ length: inst.machines }, () => []);
  const running = [];
  let stopped = writer.overflow;
  let nodes = 0;
  let best = null;
  let unsatEarly = false;

  // Remove values from a domain; log propagation entries. Returns false on
  // empty domain (conflict).
  function restrictDomain(step, keep, reason) {
    const dom = domains.get(step);
    const removed = dom.filter((v) => !keep.has(v));
    if (removed.length === 0) return true;
    writer.push({ type: 'propagate', step, removed, reason });
    domains.set(step, dom.filter((v) => keep.has(v)));
    if (domains.get(step).length === 0) {
      writer.push({ type: 'conflict', step, reason });
      return false;
    }
    return true;
  }

  // Forward checking from an assigned step to unassigned neighbors.
  function propagateFrom(step, param) {
    for (const edge of idx.compatAdj.get(step)) {
      if (assigned.has(edge.other)) continue;
      const keep = new Set();
      for (const [pa, pb] of edge.allow) {
        if (edge.firstIsSelf) {
          if (pa === param) keep.add(pb);
        } else if (pb === param) {
          keep.add(pa);
        }
      }
      const ok = restrictDomain(edge.other, keep, {
        kind: 'compat',
        from: step,
        param,
        between: [step, edge.other],
      });
      if (!ok) return false;
    }
    return true;
  }

  // Apply pins as initial assignments of domains (not scheduling decisions).
  function applyPins() {
    for (const step of Object.keys(pins).sort()) {
      const value = pins[step];
      const ok = restrictDomain(step, new Set([value]), { kind: 'pin', step, param: value });
      if (!ok) return false;
      if (!propagateFrom(step, value)) return false;
    }
    return true;
  }

  // Single-job memory infeasibility is a hard UNSAT.
  for (const s of inst.steps) {
    if (s.memory > inst.memoryLimit) {
      writer.push({ type: 'infeasible', step: s.id, reason: { kind: 'memory', memory: s.memory, limit: inst.memoryLimit } });
      unsatEarly = true;
    }
  }
  if (!unsatEarly && applyPins()) {
    // proceed to search
  } else {
    unsatEarly = true;
  }

  function lowerBound() {
    let busy = 0;
    let lb0 = 0;
    for (const rec of placed.values()) {
      busy += rec.end - rec.start;
      lb0 = Math.max(lb0, rec.end);
    }
    let remaining = 0;
    for (const s of inst.steps) if (!assigned.has(s.id)) remaining += s.duration;
    const lb1 = Math.ceil((busy + remaining) / inst.machines);
    // Precedence bound: earliest start of unplaced steps ignoring resources.
    const es = new Map();
    let lb2 = 0;
    for (const id of idx.topo) {
      let base = 0;
      for (const p of idx.preds.get(id)) base = Math.max(base, es.get(p));
      if (placed.has(id)) {
        es.set(id, placed.get(id).end);
      } else {
        const end = base + idx.byId.get(id).duration;
        es.set(id, end);
        lb2 = Math.max(lb2, end);
      }
    }
    return Math.max(lb0, lb1, lb2);
  }

  function candidateFromPlaced() {
    const jobs = [...placed.values()].sort((a, b) => (a.step < b.step ? -1 : 1));
    let makespan = 0;
    let peak = 0;
    const events = new Set();
    for (const r of running) {
      events.add(r.start);
      makespan = Math.max(makespan, r.end);
    }
    for (const pt of events) {
      let used = 0;
      for (const r of running) if (r.start <= pt && pt < r.end) used += r.mem;
      peak = Math.max(peak, used);
    }
    return { jobs, makespan, peak, key: canon(jobs) };
  }

  function recurse() {
    if (stopped) return;
    if (assigned.size === inst.steps.length) {
      const candidate = candidateFromPlaced();
      if (betterThan(candidate, best)) {
        best = candidate;
        writer.push({ type: 'solution', makespan: candidate.makespan, key: candidate.key });
      }
      return;
    }
    const lb = lowerBound();
    if (best && lb > best.makespan) {
      writer.push({ type: 'bound', lowerBound: lb, best: best.makespan, action: 'prune' });
      return;
    }
    const ready = inst.steps
      .map((s) => s.id)
      .filter((id) => !assigned.has(id) && idx.preds.get(id).every((p) => assigned.has(p)))
      .sort();
    for (const step of ready) {
      for (const param of domains.get(step)) {
        for (let machine = 0; machine < inst.machines; machine++) {
          if (stopped) return;
          nodes++;
          if (nodes > maxNodes) {
            writer.push({ type: 'budget', kind: 'nodes', limit: maxNodes });
            stopped = true;
            return;
          }
          assigned.set(step, { param, machine });
          const rec = placeOne(inst, idx, placed, machineIntervals, running, step, param, machine);
          writer.push({ type: 'decide', step, param, machine, start: rec.start, end: rec.end });
          if (writer.overflow) {
            stopped = true;
          }
          const saved = new Map();
          let ok = true;
          if (!stopped) {
            for (const edge of idx.compatAdj.get(step)) {
              if (assigned.has(edge.other)) continue;
              if (!saved.has(edge.other)) saved.set(edge.other, domains.get(edge.other));
            }
            ok = propagateFrom(step, param);
            if (writer.overflow) stopped = true;
          }
          if (!stopped && ok) recurse();
          for (const [id, dom] of saved) domains.set(id, dom);
          assigned.delete(step);
          unplaceOne(placed, machineIntervals, running, rec);
          if (!stopped) writer.push({ type: 'backtrack', step });
          if (writer.overflow) stopped = true;
        }
      }
    }
  }

  if (!unsatEarly && !stopped) recurse();

  let status;
  if (stopped) {
    status = 'PENDING';
  } else {
    status = best ? 'SAT' : 'UNSAT';
    writer.push({ type: 'done', status });
    if (writer.overflow) {
      status = 'PENDING';
      stopped = true;
    }
  }

  const plan = best
    ? { makespan: best.makespan, peak: best.peak, jobs: best.jobs }
    : null;
  return {
    status,
    plan,
    entries: writer.entries,
    nodes,
    head: writer.prev,
    budgets: {
      maxNodes: maxNodes === Infinity ? null : maxNodes,
      maxCertBytes: writer.maxBytes === Infinity ? null : writer.maxBytes,
    },
  };
}
