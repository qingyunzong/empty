import fs from 'node:fs';
import { replay } from './scheduler.js';
import { audit } from './audit.js';
import { LeaseStore, PersistError, CrashError, CRASH_POINTS } from './store.js';

export const EXIT = {
  OK: 0,
  REJECTED: 1,
  USAGE: 2,
  STALE_EPOCH: 8,
  PERSIST_INVALID: 9,
  CRASH: 75,
};

class UsageError extends Error {}

const USAGE = `usage:
  agv replay <events.jsonl|->            replay an event log, print JSONL decisions + final state
  agv lease --store DIR --task T --agv A --epoch N [--lease-ms M] [--now MS] [--crash-at P]
  agv recover --store DIR                recover a store after a crash
  agv audit <events.jsonl|-> [--store DIR]
crash points: ${CRASH_POINTS.join(', ')}
exit codes: 0 ok, 1 rejected/audit-violations, 2 usage, 8 stale-epoch, 9 persistence-invalid, 75 simulated crash`;

function parseOpts(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = args[i + 1];
        i += 1;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function parseJsonl(text, source) {
  const events = [];
  text.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      events.push(JSON.parse(s));
    } catch {
      throw new UsageError(`${source}:${i + 1}: invalid JSON line`);
    }
  });
  return events;
}

function readInput(file, readStdin) {
  if (!file || file === '-') return { text: readStdin(), source: '<stdin>' };
  return { text: fs.readFileSync(file, 'utf8'), source: file };
}

function cmdReplay(args, io) {
  const opts = parseOpts(args);
  const { text, source } = readInput(opts._[0], io.readStdin);
  const events = parseJsonl(text, source);
  const scheduler = replay(events);
  for (const d of scheduler.decisions) io.out(JSON.stringify(d));
  const snap = scheduler.snapshot();
  for (const t of snap.tasks) io.out(JSON.stringify(t));
  for (const m of snap.members) io.out(JSON.stringify(m));
  io.out(JSON.stringify(snap.summary));
  return EXIT.OK;
}

function cmdLease(args, io) {
  const opts = parseOpts(args);
  const { store: dir, task, agv } = opts;
  if (!dir || !task || !agv) throw new UsageError('lease requires --store, --task, --agv');
  const epoch = Number(opts.epoch);
  if (!Number.isInteger(epoch) || epoch < 1) throw new UsageError('--epoch must be a positive integer');
  const leaseMs = opts['lease-ms'] !== undefined ? Number(opts['lease-ms']) : 1000;
  const now = opts.now !== undefined ? Number(opts.now) : Date.now();
  const crashAt = opts['crash-at'];
  if (crashAt !== undefined && !CRASH_POINTS.includes(crashAt)) {
    throw new UsageError(`--crash-at must be one of: ${CRASH_POINTS.join(', ')}`);
  }

  const store = new LeaseStore(dir);
  const state = store.load();
  const fencing = state.fencing[task] ?? 0;
  const cur = state.leases[task];
  const live = cur && now <= cur.leaseExpiry;

  const stale = () => {
    io.out(JSON.stringify({ type: 'lease', task, agv, granted: false, reason: 'stale-epoch', epoch, fencing }));
    return EXIT.STALE_EPOCH;
  };

  if (cur && cur.owner === agv) {
    if (epoch < fencing) return stale();
    state.fencing[task] = Math.max(fencing, epoch);
    state.leases[task] = { owner: agv, epoch: state.fencing[task], leaseStart: now, leaseExpiry: now + leaseMs };
    store.commit(state, { crashAt });
    io.out(JSON.stringify({ type: 'lease', task, agv, granted: true, result: 'renewed', epoch: state.fencing[task], leaseExpiry: now + leaseMs }));
    return EXIT.OK;
  }
  if (epoch <= fencing) return stale();
  if (live) {
    io.out(JSON.stringify({ type: 'lease', task, agv, granted: false, reason: 'held', owner: cur.owner, leaseExpiry: cur.leaseExpiry }));
    return EXIT.REJECTED;
  }
  state.fencing[task] = epoch;
  state.leases[task] = { owner: agv, epoch, leaseStart: now, leaseExpiry: now + leaseMs };
  store.commit(state, { crashAt });
  io.out(JSON.stringify({ type: 'lease', task, agv, granted: true, result: 'granted', epoch, leaseExpiry: now + leaseMs }));
  return EXIT.OK;
}

function cmdRecover(args, io) {
  const opts = parseOpts(args);
  if (!opts.store) throw new UsageError('recover requires --store DIR');
  const store = new LeaseStore(opts.store);
  const { action, state } = store.recover();
  io.out(JSON.stringify({
    type: 'recover',
    action,
    leases: Object.keys(state.leases).sort(),
    fencing: state.fencing,
  }));
  return EXIT.OK;
}

function cmdAudit(args, io) {
  const opts = parseOpts(args);
  const { text, source } = readInput(opts._[0], io.readStdin);
  const events = parseJsonl(text, source);
  let storeState = null;
  if (opts.store) storeState = new LeaseStore(opts.store).load();
  const result = audit(events, storeState);
  for (const v of result.violations) io.out(JSON.stringify({ type: 'violation', ...v }));
  io.out(JSON.stringify({ type: 'audit', ok: result.ok, checks: result.checks, violations: result.violations.length }));
  return result.ok ? EXIT.OK : EXIT.REJECTED;
}

export function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const readStdin = io.stdin ?? (() => fs.readFileSync(0, 'utf8'));
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'replay': return cmdReplay(rest, { out, readStdin });
      case 'lease': return cmdLease(rest, { out });
      case 'recover': return cmdRecover(rest, { out });
      case 'audit': return cmdAudit(rest, { out, readStdin });
      case undefined:
      case 'help':
      case '--help':
        err(USAGE);
        return cmd === undefined ? EXIT.USAGE : EXIT.OK;
      default:
        err(`unknown command: ${cmd}\n${USAGE}`);
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof PersistError) {
      out(JSON.stringify({ type: 'error', reason: 'persist-invalid', message: e.message }));
      return EXIT.PERSIST_INVALID;
    }
    if (e instanceof CrashError) {
      out(JSON.stringify({ type: 'crash', at: e.point }));
      return EXIT.CRASH;
    }
    if (e instanceof UsageError) {
      err(e.message);
      return EXIT.USAGE;
    }
    throw e;
  }
}
