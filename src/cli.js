#!/usr/bin/env node
import { Store } from './store.js';
import { computeSchedule, computeDrops } from './scheduler.js';
import { DomainError, VerifyError } from './util.js';

class UsageError extends Error {}

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function reqStr(v, name) {
  if (typeof v !== 'string' || v.length === 0) throw new UsageError(`missing --${name}`);
  return v;
}

function reqInt(v, name) {
  if (v === undefined || v === true) throw new UsageError(`missing --${name}`);
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

function optInt(v, name) {
  if (v === undefined) return undefined;
  return reqInt(v, name);
}

function printSeconds(sched, st, out) {
  if (sched.segments.length === 0) {
    out('(empty timeline)');
    return;
  }
  const setup = st.config.setup;
  const marks = new Map();
  let prevEnd = null;
  for (const seg of sched.segments) {
    const setupStart = prevEnd === null ? seg.start : Math.max(prevEnd, seg.start - setup);
    for (let t = setupStart; t < seg.start; t++) marks.set(t, `SETUP ${seg.pass}`);
    for (let t = seg.start; t < seg.end; t++) marks.set(t, `DOWNLINK ${seg.pass} ${seg.task}`);
    prevEnd = seg.end;
  }
  const last = sched.segments[sched.segments.length - 1].end;
  for (let t = 0; t < last; t++) out(`${t}\t${marks.get(t) ?? 'IDLE'}`);
}

function cmdSchedule(store, flags, out) {
  const st = store.state();
  if (!st.config) throw new UsageError('empty journal; add a pass first');
  const sched = computeSchedule(st);
  if (flags.seconds) {
    printSeconds(sched, st, out);
  } else {
    out('START\tEND\tSTATE\tPASS\tTASK\tBYTES');
    let prevEnd = null;
    for (const seg of sched.segments) {
      if (prevEnd !== null && seg.start > prevEnd) {
        const ss = Math.max(prevEnd, seg.start - st.config.setup);
        if (ss < seg.start) out(`${ss}\t${seg.start}\tSETUP\t${seg.pass}\t${seg.task}\t0`);
      }
      out(`${seg.start}\t${seg.end}\tDOWNLINK\t${seg.pass}\t${seg.task}\t${seg.bytes}`);
      prevEnd = seg.end;
    }
  }
  out('TASK\tSERVED');
  for (const [task, bytes] of Object.entries(sched.served).sort()) {
    out(`${task}\t${bytes}`);
  }
  const head = store.head();
  out(`CERTIFICATE\tseq=${head.seq}\thead=${head.hash}`);
}

function cmdDrop(store, out) {
  const st = store.state();
  if (!st.config) throw new UsageError('empty journal; add a pass first');
  const sched = computeSchedule(st);
  const { drops, totals } = computeDrops(st, sched);
  out('PASS\tTASK\tSERVED\tWEATHER\tCONFLICT\tQUOTA\tPENDING');
  for (const d of drops) {
    out(
      `${d.pass}\t${d.task}\t${d.served}\t${d.dropped.weather}\t${d.dropped.conflict}\t${d.dropped.quota}\t${d.pending}`
    );
  }
  out(
    `TOTALS\tserved=${totals.served}\tweather=${totals.weather}\tconflict=${totals.conflict}\tquota=${totals.quota}\tpending=${totals.pending}\tfailed=${totals.failed}`
  );
}

function cmdVerify(store, flags, out, err) {
  const report = store.verify();
  if (report.ok) {
    out(`OK\tseq=${report.entries}\thead=${report.head}\tstate=${report.state}`);
    return 0;
  }
  if (flags.recover) {
    const rec = store.recover();
    const after = store.verify();
    err(`rejected corrupt tail at line ${report.badLine}: ${report.reason}`);
    out(`RECOVERED\tremoved=${rec.removed}\tseq=${after.entries}\thead=${after.head}`);
    return 0;
  }
  err(`INVALID\tline=${report.badLine}\t${report.reason}`);
  return 8;
}

function dispatch(argv, io) {
  const out = io.stdout;
  const { flags, pos } = parseFlags(argv);
  const cmd = pos[0];
  if (!cmd) throw new UsageError('missing command (pass|schedule|correct|drop|undo|verify)');
  const dir = typeof flags.dir === 'string' ? flags.dir : '.satsched';
  const store = new Store(dir);
  const config = {
    setup: optInt(flags.setup, 'setup') ?? 10,
    lock: optInt(flags.lock, 'lock') ?? 30,
    maxRate: optInt(flags['max-rate'], 'max-rate') ?? 1_000_000,
  };

  switch (cmd) {
    case 'pass': {
      store.ensureInit(config);
      const pass = {
        id: reqStr(flags.id, 'id'),
        task: reqStr(flags.task, 'task'),
        start: reqInt(flags.start, 'start'),
        end: reqInt(flags.end, 'end'),
        elevation: reqInt(flags.elevation, 'elevation'),
        rate: reqInt(flags.rate, 'rate'),
        priority: optInt(flags.priority, 'priority') ?? 0,
        onboard: reqInt(flags.onboard, 'onboard'),
      };
      const task = {};
      if (flags.quota !== undefined) task.quota = reqInt(flags.quota, 'quota');
      if (flags['min-guarantee'] !== undefined) {
        task.minGuarantee = reqInt(flags['min-guarantee'], 'min-guarantee');
      }
      const e = store.append('pass', { pass, task });
      out(`PASS\t${pass.id}\tseq=${e.seq}`);
      return 0;
    }
    case 'schedule':
      cmdSchedule(store, flags, out);
      return 0;
    case 'correct': {
      store.ensureInit(config);
      if (flags.confirm) {
        const e = store.append('confirm', { pass: reqStr(flags.pass, 'pass') });
        out(`CONFIRM\t${flags.pass}\tseq=${e.seq}`);
      } else {
        const payload = {
          pass: reqStr(flags.pass, 'pass'),
          start: reqInt(flags.start, 'start'),
          end: reqInt(flags.end, 'end'),
          at: optInt(flags.at, 'at') ?? 0,
          pending: !!flags.pending,
        };
        const e = store.append('correct', payload);
        out(`CORRECT\t${payload.pass}\tseq=${e.seq}\tconfirmed=${e.payload.confirmed.length}`);
      }
      return 0;
    }
    case 'drop':
      cmdDrop(store, out);
      return 0;
    case 'undo': {
      const toPass = flags['to-pass'];
      const steps = optInt(flags.steps, 'steps');
      const e = store.undo(toPass !== undefined ? { toPass: reqStr(toPass, 'to-pass') } : { steps });
      out(`UNDO\tseq=${e.seq}\tremoved=${e.payload.removed.join(',')}`);
      return 0;
    }
    case 'verify':
      return cmdVerify(store, flags, io.stdout, io.stderr);
    default:
      throw new UsageError(`unknown command ${cmd}`);
  }
}

// Programmatic entry: returns the exit code, routes output through `io`.
export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));
  try {
    return dispatch(argv, { stdout, stderr });
  } catch (err) {
    if (err instanceof DomainError) {
      stderr(`error: ${err.message}`);
      return 9;
    }
    if (err instanceof VerifyError) {
      stderr(`verify: ${err.message}`);
      return 8;
    }
    if (err instanceof UsageError) {
      stderr(`usage: ${err.message}`);
      return 2;
    }
    stderr(`fatal: ${err.message}`);
    return 1;
  }
}

const invokedAsMain =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedAsMain) {
  process.exit(runCli(process.argv.slice(2)));
}
