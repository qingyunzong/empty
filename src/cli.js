import fs from 'node:fs';
import path from 'node:path';
import { FILES, initStore, commitStore, recover, stateHashOf, faultPoint, injectCrash } from './store.js';
import { appendEntry, makeEntry, logHash } from './log.js';
import { tick, mergeClocks } from './clock.js';
import { fold, sortEntries } from './fold.js';
import { computeTimes, validate, opTable } from './model.js';
import { certificate, prettyCanonical } from './cert.js';
import { PlanSyncError, validation, usage } from './errors.js';
import { canon, fsyncDir, fsyncFile } from './util.js';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 >= argv.length) throw usage(`missing value for --${key}`);
      opts[key] = argv[++i];
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function readJson(src, what) {
  try {
    if (src === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
    if (src.startsWith('@')) return JSON.parse(fs.readFileSync(src.slice(1), 'utf8'));
    return JSON.parse(src);
  } catch (err) {
    throw usage(`invalid JSON for ${what}: ${err.message}`);
  }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function snapshotOf(node, plan, entries, dyn, pending, clock) {
  return {
    format: 1, node, plan, dyn, pending, clock,
    logLen: entries.length, logHash: logHash(entries), stateHash: stateHashOf(dyn),
  };
}

function writeLogAtomic(dir, entries) {
  const target = path.join(dir, FILES.log);
  const tmp = target + '.tmp';
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(tmp, text);
  fsyncFile(tmp);
  fs.renameSync(tmp, target);
  fsyncDir(dir);
}

function validateChange(rec, change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw validation('change must be an object');
  const ops = opTable(rec.plan, rec.dyn);
  const mach = rec.plan.machines.find((m) => m.id === change.machine);
  if (change.type === 'insert') {
    const o = change.op;
    if (!o || !o.id || !o.job || !o.cap || !(o.dur > 0)) throw validation('insert requires op{id,job,cap,dur>0}');
    if (ops.has(o.id)) throw validation(`op ${o.id} already exists`);
    if (!rec.plan.jobs.some((j) => j.id === o.job)) throw validation(`unknown job ${o.job}`);
    if (!mach) throw validation(`unknown machine ${change.machine}`);
    if (!mach.caps.includes(o.cap)) throw validation(`machine ${mach.id} lacks capability ${o.cap}`);
  } else if (change.type === 'move') {
    if (!ops.has(change.op)) throw validation(`unknown op ${change.op}`);
    if (!mach) throw validation(`unknown machine ${change.machine}`);
    if (!mach.caps.includes(ops.get(change.op).cap))
      throw validation(`machine ${mach.id} lacks capability ${ops.get(change.op).cap}`);
  } else if (change.type === 'cancel') {
    if (!ops.has(change.op)) throw validation(`unknown op ${change.op}`);
  } else {
    throw validation(`unknown change type ${change.type}`);
  }
}

function cmdInit(opts) {
  if (!opts.dir) throw usage('init requires --dir');
  if (!opts.plan) throw usage('init requires --plan');
  const plan = readJson(opts.plan, '--plan');
  const node = opts.node ?? 'A';
  initStore(opts.dir, plan, node);
  out({ initialized: true, dir: opts.dir, node });
  return 0;
}

function cmdApply(opts) {
  if (!opts.dir) throw usage('apply requires --dir');
  if (!opts.change) throw usage('apply requires --change');
  const rec = recover(opts.dir);
  const change = readJson(opts.change, '--change');
  validateChange(rec, change);
  const clock = tick(rec.clock, rec.node);
  const prev = rec.entries.length ? rec.entries[rec.entries.length - 1].hash : null;
  const entry = makeEntry(rec.node, clock, change, prev);
  const fault = faultPoint();
  if (fault === 'before-append') injectCrash('before-append');
  const entries = [...rec.entries, entry];
  const { dyn, pending } = fold(rec.plan, entries);
  const { violations, times } = validate(rec.plan, dyn);
  if (violations.length) {
    out({ applied: false, violations, pending });
    return 2;
  }
  const logPath = path.join(opts.dir, FILES.log);
  if (fault === 'after-append-no-fsync') {
    fs.appendFileSync(logPath, JSON.stringify(entry));
    injectCrash('after-append-no-fsync');
  }
  appendEntry(logPath, entry);
  commitStore(opts.dir, snapshotOf(rec.node, rec.plan, entries, dyn, pending, clock));
  out({ applied: true, hash: entry.hash, clock, cost: times.cost, pending });
  return 0;
}

function cmdSync(opts) {
  if (!opts.a || !opts.b) throw usage('sync requires --a and --b');
  const ra = recover(opts.a);
  const rb = recover(opts.b);
  if (canon(ra.plan) !== canon(rb.plan)) throw validation('plan mismatch between terminals');
  const byHash = new Map();
  for (const e of [...ra.entries, ...rb.entries]) byHash.set(e.hash, e);
  const merged = sortEntries([...byHash.values()]);
  const { dyn, pending } = fold(ra.plan, merged);
  const clock = mergeClocks(ra.clock, rb.clock);
  const { violations, times } = validate(ra.plan, dyn);
  for (const rec of [ra, rb]) {
    writeLogAtomic(rec.dir, merged);
    commitStore(rec.dir, snapshotOf(rec.node, rec.plan, merged, dyn, pending, clock));
  }
  const stateHash = stateHashOf(dyn);
  out({ converged: true, stateHash, clock, cost: times ? times.cost : null, violations, pending });
  if (violations.length) return 2;
  if (pending.length) return 3;
  return 0;
}

function cmdResume(opts) {
  if (!opts.dir) throw usage('resume requires --dir');
  const rec = recover(opts.dir);
  out({
    status: 'recovered',
    committed: {
      status: rec.manifest.status,
      stateHash: rec.manifest.stateHash,
      logLen: rec.manifest.logLen,
      clock: rec.manifest.clock,
    },
    discardedTmpSnapshot: rec.report.discardedTmpSnapshot,
    truncatedTail: rec.report.truncatedTail,
    replayed: rec.report.replayed,
    clock: rec.clock,
    pending: rec.pending.length,
  });
  return 0;
}

function cmdVerify(opts) {
  if (!opts.dir) throw usage('verify requires --dir');
  const rec = recover(opts.dir);
  const { violations, times } = validate(rec.plan, rec.dyn);
  out({
    valid: violations.length === 0,
    violations,
    cost: times ? times.cost : null,
    budget: rec.plan.budget,
    pending: rec.pending,
    clock: rec.clock,
  });
  if (violations.length) return 2;
  if (rec.pending.length) return 3;
  return 0;
}

function cmdExportCert(opts) {
  if (!opts.dir) throw usage('export-cert requires --dir');
  const rec = recover(opts.dir);
  const times = computeTimes(rec.plan, rec.dyn);
  const cert = certificate({ plan: rec.plan, entries: rec.entries, dyn: rec.dyn, pending: rec.pending, clock: rec.clock, times });
  const text = prettyCanonical(cert);
  if (opts.out) fs.writeFileSync(opts.out, text);
  else process.stdout.write(text);
  return 0;
}

export function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return reportError(err);
  }
  const cmd = opts._[0];
  try {
    switch (cmd) {
      case 'init': return cmdInit(opts);
      case 'apply': return cmdApply(opts);
      case 'sync': return cmdSync(opts);
      case 'resume': return cmdResume(opts);
      case 'verify': return cmdVerify(opts);
      case 'export-cert': return cmdExportCert(opts);
      default: throw usage(`unknown command: ${cmd ?? '(none)'}`);
    }
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err) {
  if (err instanceof PlanSyncError) {
    process.stderr.write(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }) + '\n');
    return err.exitCode;
  }
  process.stderr.write(JSON.stringify({ error: { code: 'INTERNAL', message: String((err && err.message) || err) } }) + '\n');
  return 1;
}
