// CLI: agv replay | lease | recover | audit   (JSONL in, JSONL out)
// Exit codes: 0 ok | 1 audit violations | 2 usage | 8 stale claim |
//             9 persistence validation failure | 70 simulated crash

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Engine } from './engine.js';
import { Store, Scheduler, PersistenceError, CrashInjected, EXIT, CRASH_POINTS } from './persist.js';
import { audit } from './audit.js';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.USAGE;
  }
}

function readJsonl(file) {
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const events = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    line += 1;
    try {
      events.push(JSON.parse(raw));
    } catch {
      throw new UsageError(`input line ${line}: invalid JSON`);
    }
  }
  return events;
}

function writeOut(file, text) {
  if (file) fs.writeFileSync(file, text);
  else process.stdout.write(text);
}

function cmdReplay(args) {
  const { values } = parseArgs({
    args,
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      state: { type: 'string' },
      'crash-point': { type: 'string' },
    },
  });
  if (!values.in) throw new UsageError('replay requires --in <events.jsonl> (or - for stdin)');
  if (values['crash-point'] && !CRASH_POINTS.includes(values['crash-point'])) {
    throw new UsageError(`unknown crash point (expected one of ${CRASH_POINTS.join(', ')})`);
  }
  const events = readJsonl(values.in);
  const scheduler = values.state ? Scheduler.open(values.state) : null;
  const engine = scheduler ? scheduler.engine : new Engine();
  const lines = [];
  let code = EXIT.OK;
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    const res = scheduler
      ? scheduler.applyEvent(ev, { crashPoint: values['crash-point'] })
      : engine.applyEvent(ev);
    if (res.decision === 'stale') code = EXIT.STALE;
    const { lease, journal, ...details } = res;
    lines.push(JSON.stringify({ seq, ...ev, ...details }));
  }
  const summary = scheduler ? scheduler.summary() : engine.summary();
  lines.push(JSON.stringify(summary));
  writeOut(values.out, `${lines.join('\n')}\n`);
  return code;
}

function cmdLease(args) {
  const [sub, ...rest] = args;
  if (sub === 'claim') {
    const { values } = parseArgs({
      args: rest,
      options: {
        state: { type: 'string' },
        task: { type: 'string' },
        agv: { type: 'string' },
        epoch: { type: 'string' },
        ttl: { type: 'string' },
        now: { type: 'string' },
        clock: { type: 'string' },
        'crash-point': { type: 'string' },
      },
    });
    for (const key of ['state', 'task', 'agv', 'epoch']) {
      if (!values[key]) throw new UsageError(`lease claim requires --${key}`);
    }
    const scheduler = Scheduler.open(values.state);
    const ts = values.now !== undefined ? Number(values.now) : scheduler.engine.now;
    if (!scheduler.engine.members.has(values.agv)) {
      // First contact auto-join (single-op convenience; replay stays strict).
      scheduler.applyEvent({ type: 'join', agv: values.agv, ts });
    }
    let clock;
    if (values.clock) {
      try {
        clock = JSON.parse(values.clock);
      } catch {
        throw new UsageError('--clock must be a JSON object');
      }
    }
    const res = scheduler.applyEvent(
      {
        type: 'claim',
        task: values.task,
        agv: values.agv,
        epoch: Number(values.epoch),
        ttl: values.ttl !== undefined ? Number(values.ttl) : undefined,
        ts,
        clock,
      },
      { crashPoint: values['crash-point'] },
    );
    const { lease, journal, ...details } = res;
    process.stdout.write(`${JSON.stringify({ task: values.task, agv: values.agv, ...details })}\n`);
    return res.decision === 'stale' ? EXIT.STALE : EXIT.OK;
  }
  if (sub === 'show') {
    const { values } = parseArgs({
      args: rest,
      options: { state: { type: 'string' }, task: { type: 'string' } },
    });
    if (!values.state || !values.task) throw new UsageError('lease show requires --state and --task');
    const store = Store.init(values.state);
    store.recover();
    const rec = store.readLeaseFile(values.task);
    process.stdout.write(`${JSON.stringify(rec ?? { task: values.task, status: 'none' })}\n`);
    return EXIT.OK;
  }
  throw new UsageError('lease requires a subcommand: claim | show');
}

function cmdRecover(args) {
  const { values } = parseArgs({ args, options: { state: { type: 'string' } } });
  if (!values.state) throw new UsageError('recover requires --state <dir>');
  const store = Store.init(values.state);
  const report = store.recover();
  const lines = report.map((r) => JSON.stringify(r));
  lines.push(JSON.stringify({ type: 'recovery', ok: true, actions: report.length - 1 }));
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT.OK;
}

function cmdAudit(args) {
  const { values } = parseArgs({ args, options: { state: { type: 'string' } } });
  if (!values.state) throw new UsageError('audit requires --state <dir>');
  const result = audit(values.state);
  const lines = [];
  for (const check of result.report) lines.push(JSON.stringify(check));
  for (const v of result.violations) lines.push(JSON.stringify({ violation: v }));
  lines.push(JSON.stringify({ type: 'audit', ok: result.ok, violations: result.violations.length }));
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.ok ? EXIT.OK : EXIT.AUDIT_VIOLATION;
}

function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'replay':
      return cmdReplay(rest);
    case 'lease':
      return cmdLease(rest);
    case 'recover':
      return cmdRecover(rest);
    case 'audit':
      return cmdAudit(rest);
    default:
      throw new UsageError('usage: agv <replay|lease|recover|audit> [options]');
  }
}

export function main(argv) {
  try {
    return run(argv);
  } catch (err) {
    if (err instanceof CrashInjected) {
      process.stderr.write(`${JSON.stringify({ type: 'crash', point: err.point })}\n`);
      return EXIT.CRASH;
    }
    if (err instanceof PersistenceError) {
      process.stderr.write(`${JSON.stringify({ type: 'error', kind: 'persistence', message: err.message })}\n`);
      return EXIT.PERSIST;
    }
    if (err instanceof UsageError) {
      process.stderr.write(`${JSON.stringify({ type: 'error', kind: 'usage', message: err.message })}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }
}
