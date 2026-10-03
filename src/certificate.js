import { canon, sha256hex } from './canon.js';
import { solve } from './solver.js';
import { validateInstance, indexInstance } from './instance.js';
import { invalidInput } from './errors.js';

// A certificate file is self-contained:
// { instance, pins, budgets, entries, status, plan|null }
export function makeCertificate(inst, pins, result) {
  return {
    instance: inst,
    pins,
    budgets: result.budgets,
    entries: result.entries,
    status: result.status,
    plan: result.plan,
  };
}

function checkChain(entries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== (i === 0 ? entries[0].seq : entries[i - 1].seq + 1)) {
      return `entry ${i}: non-sequential seq`;
    }
    if (i > 0 && e.prev !== entries[i - 1].hash) return `entry ${i}: prev hash mismatch`;
    const expect = sha256hex(e.prev + '\n' + canon(e.entry));
    if (e.hash !== expect) return `entry ${i}: hash mismatch`;
  }
  return null;
}

// Independent feasibility check of a plan against the instance and pins.
function checkPlan(inst, pins, plan) {
  const idx = indexInstance(inst);
  const byStep = new Map(plan.jobs.map((j) => [j.step, j]));
  if (byStep.size !== inst.steps.length) return 'plan does not cover all steps exactly once';
  for (const s of inst.steps) {
    const j = byStep.get(s.id);
    if (!j) return `missing step ${s.id}`;
    if (!s.params.includes(j.param)) return `step ${s.id}: param not in domain`;
    if (j.machine < 0 || j.machine >= inst.machines) return `step ${s.id}: bad machine`;
    if (j.end !== j.start + s.duration) return `step ${s.id}: bad end time`;
    if (pins[s.id] !== undefined && pins[s.id] !== j.param) return `step ${s.id}: violates pin`;
  }
  for (const [a, b] of inst.edges) {
    if (byStep.get(a).end > byStep.get(b).start) return `edge ${a}->${b} violated`;
  }
  for (const c of inst.compat) {
    const [a, b] = c.between;
    const pair = [byStep.get(a).param, byStep.get(b).param];
    if (!c.allow.some(([x, y]) => x === pair[0] && y === pair[1])) {
      return `compat ${a}:${b} violated`;
    }
  }
  // Machine overlap and memory peak.
  const events = new Set();
  for (const j of plan.jobs) events.add(j.start);
  for (const m of Array.from({ length: inst.machines }, (_, i) => i)) {
    const onM = plan.jobs.filter((j) => j.machine === m);
    for (let i = 0; i < onM.length; i++) {
      for (let k = i + 1; k < onM.length; k++) {
        if (onM[i].start < onM[k].end && onM[k].start < onM[i].end) {
          return `machine ${m} overlap`;
        }
      }
    }
  }
  for (const pt of events) {
    let used = 0;
    for (const j of plan.jobs) {
      if (j.start <= pt && pt < j.end) used += idx.byId.get(j.step).memory;
    }
    if (used > inst.memoryLimit) return 'memory limit exceeded';
  }
  let makespan = 0;
  for (const j of plan.jobs) makespan = Math.max(makespan, j.end);
  if (makespan !== plan.makespan) return 'makespan mismatch';
  return null;
}

// Verify a certificate: structural hash-chain check, deterministic
// re-execution of the solver, and independent plan feasibility.
// Returns { status: 'VALID' } or { status: 'INVALID', reason }.
export function verifyCertificate(cert) {
  if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) {
    throw invalidInput('certificate must be an object');
  }
  for (const key of ['instance', 'pins', 'budgets', 'entries', 'status']) {
    if (!(key in cert)) throw invalidInput(`certificate missing field ${JSON.stringify(key)}`);
  }
  if (!['SAT', 'UNSAT', 'PENDING'].includes(cert.status)) {
    throw invalidInput('certificate status must be SAT, UNSAT or PENDING');
  }
  if (!Array.isArray(cert.entries)) throw invalidInput('certificate entries must be an array');
  const inst = validateInstance(cert.instance);

  const chainError = checkChain(cert.entries);
  if (chainError) return { status: 'INVALID', reason: `hash chain broken: ${chainError}` };

  const first = cert.entries[0];
  const budgets = cert.budgets ?? {};
  const pins = cert.pins ?? {};
  const rerun = solve(inst, {
    pins,
    maxNodes: budgets.maxNodes ?? Infinity,
    maxCertBytes: budgets.maxCertBytes ?? Infinity,
    prevHash: first ? first.prev : undefined,
    seqStart: first ? first.seq : 0,
  });
  if (canon(rerun.entries) !== canon(cert.entries)) {
    return { status: 'INVALID', reason: 'replay diverges from certificate entries' };
  }
  if (rerun.status !== cert.status) {
    return { status: 'INVALID', reason: `status mismatch: replay=${rerun.status} cert=${cert.status}` };
  }
  if (cert.status === 'SAT') {
    if (!cert.plan) return { status: 'INVALID', reason: 'SAT certificate without plan' };
    if (canon(rerun.plan) !== canon(cert.plan)) {
      return { status: 'INVALID', reason: 'plan mismatch with replay' };
    }
    const planError = checkPlan(inst, pins, cert.plan);
    if (planError) return { status: 'INVALID', reason: `infeasible plan: ${planError}` };
  }
  if (cert.status === 'UNSAT' && cert.plan) {
    return { status: 'INVALID', reason: 'UNSAT certificate carries a plan' };
  }
  return { status: 'VALID' };
}
