import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash } from './canon.js';
import {
  recover, persist, appendChange, writeLog,
  loadIdentity, saveIdentity, RecoveryError,
} from './store.js';
import { applyChange, validatePlan, penalty, PlanError } from './plan.js';
import { materialize, topoSortChanges } from './materialize.js';
import { mergeClocks } from './clock.js';
import { buildCertificate } from './cert.js';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(code, type, message, extra = {}) {
  fs.writeSync(2, JSON.stringify({ error: { code, type, message, ...extra } }) + '\n');
  process.exit(code);
}

function parseOpts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) o[a.slice(2)] = args[++i];
    else o._.push(a);
  }
  return o;
}

const TYPES = new Set(['insert', 'move', 'cancel']);

function cmdApply(opts) {
  const dir = opts.dir;
  if (!dir) fail(1, 'usage', 'apply requires --dir');
  const type = opts.type;
  if (!TYPES.has(type)) fail(1, 'usage', 'apply requires --type insert|move|cancel');
  let data;
  try { data = JSON.parse(opts.data || '{}'); }
  catch { fail(1, 'usage', '--data must be valid JSON'); }
  if (type === 'move' && data.machine === undefined && data.start === undefined) {
    fail(2, 'validation', 'move requires machine and/or start');
  }
  const node = opts.node || loadIdentity(dir) || path.basename(path.resolve(dir));
  const { state } = recover(dir);
  const counter = state.changes.filter((c) => c.node === node).length + 1;
  const change = {
    changeId: `${node}:${counter}`,
    node,
    clock: { ...state.clock, [node]: (state.clock[node] || 0) + 1 },
    type,
    op: data,
  };
  const current = materialize(state.base, state.changes, state.constraints).plan;
  let next;
  try {
    next = applyChange(current, change);
  } catch (e) {
    if (e instanceof PlanError) fail(2, 'validation', 'change rejected', { violations: e.violations });
    throw e;
  }
  const violations = validatePlan(next, state.constraints);
  if (violations.length) fail(2, 'validation', 'change violates constraints', { violations });
  appendChange(dir, change);
  state.changes.push(change);
  state.clock = mergeClocks(state.clock, change.clock);
  persist(state);
  saveIdentity(dir, node);
  out({ ok: true, changeId: change.changeId, clock: state.clock, logLen: state.changes.length, cost: penalty(next) });
}

function cmdSync(opts) {
  const dirA = opts.dir;
  const dirB = opts.peer;
  if (!dirA || !dirB) fail(1, 'usage', 'sync requires --dir and --peer');
  const a = recover(dirA).state;
  const b = recover(dirB).state;
  if (hash(a.base) !== hash(b.base)) fail(2, 'validation', 'base plans differ between replicas');
  const byId = new Map();
  for (const c of [...a.changes, ...b.changes]) byId.set(c.changeId, c);
  const changes = topoSortChanges([...byId.values()]);
  const clock = mergeClocks(a.clock, b.clock);
  writeLog(dirA, changes);
  writeLog(dirB, changes);
  let report = null;
  for (const [dir, st] of [[dirA, a], [dirB, b]]) {
    const state = { dir, base: st.base, constraints: st.constraints, changes, clock };
    persist(state);
    if (dir === dirA) {
      const m = materialize(state.base, changes, state.constraints);
      report = { pending: m.pending, conflicts: m.conflicts, cost: penalty(m.plan) };
    }
  }
  out({
    ok: report.pending.length === 0,
    logLen: changes.length,
    clock,
    cost: report.cost,
    conflicts: report.conflicts,
    pending: report.pending,
  });
  if (report.pending.length) process.exit(3);
}

function cmdResume(opts) {
  const dir = opts.dir;
  if (!dir) fail(1, 'usage', 'resume requires --dir');
  const { state, report } = recover(dir);
  persist(state);
  const m = materialize(state.base, state.changes, state.constraints);
  out({ ok: true, ...report, pending: m.pending.length, cost: penalty(m.plan) });
}

function cmdVerify(opts) {
  const dir = opts.dir;
  if (!dir) fail(1, 'usage', 'verify requires --dir');
  const { state } = recover(dir);
  const m = materialize(state.base, state.changes, state.constraints);
  const violations = validatePlan(m.plan, state.constraints);
  out({
    ok: violations.length === 0 && m.pending.length === 0,
    cost: penalty(m.plan),
    violations,
    pending: m.pending,
  });
  if (violations.length) process.exit(2);
  if (m.pending.length) process.exit(3);
}

function cmdExportCert(opts) {
  const dir = opts.dir;
  if (!dir) fail(1, 'usage', 'export-cert requires --dir');
  const { state } = recover(dir);
  const m = materialize(state.base, state.changes, state.constraints);
  const { cert, certHash } = buildCertificate(state, m);
  if (opts.out) {
    fs.writeFileSync(opts.out, canonical(cert) + '\n');
    out({ ok: true, certHash, out: opts.out });
  } else {
    out({ ok: true, certHash, cert });
  }
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseOpts(rest);
  try {
    switch (cmd) {
      case 'apply': return cmdApply(opts);
      case 'sync': return cmdSync(opts);
      case 'resume': return cmdResume(opts);
      case 'verify': return cmdVerify(opts);
      case 'export-cert': return cmdExportCert(opts);
      default: return fail(1, 'usage', 'unknown command; use apply|sync|resume|verify|export-cert');
    }
  } catch (e) {
    if (e instanceof RecoveryError) fail(4, 'recovery', e.message);
    throw e;
  }
}
