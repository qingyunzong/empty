import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { parseEvents } from './events.js';
import { GateState } from './state.js';
import { buildSchedule } from './schedule.js';
import { findCounterexample } from './counterexample.js';
import { GateError } from './errors.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

function cmdRun(a, config, io) {
  const events = parseEvents(readFileSync(a.events, 'utf8'));
  const state = new GateState(config);
  const audit = [];
  for (const ev of events) {
    state.apply(ev);
    audit.push({ seq: ev.seq, hash: state.hash() });
  }
  const sched = buildSchedule(config, state);
  const scheduleOut = {
    date: sched.date,
    queue: sched.queue,
    unscheduled: sched.unscheduled,
    remainingCapability: sched.remainingCapability,
    finalHash: state.hash(),
  };
  const breachOut = {
    breaches: [...state.breaches, ...sched.scheduleBreaches],
    compensations: state.compensations,
  };
  writeFileSync(a.out ?? 'schedule.out.json', JSON.stringify(scheduleOut, null, 2) + '\n');
  writeFileSync(a.breach ?? 'breach.json', JSON.stringify(breachOut, null, 2) + '\n');
  writeFileSync(
    a.audit ?? 'audit.jsonl',
    audit.map((h) => JSON.stringify(h)).join('\n') + (audit.length ? '\n' : ''),
  );
  io.stdout(
    `events=${events.length} queued=${sched.queue.length} unscheduled=${sched.unscheduled.length} ` +
      `breaches=${breachOut.breaches.length} compensations=${state.compensations.length} hash=${state.hash()}`,
  );
  return 0;
}

function cmdReplay(a, config, io) {
  const events = parseEvents(readFileSync(a.events, 'utf8'));
  const from = Number(a.from ?? 0);
  const audit = readFileSync(a.audit ?? 'audit.jsonl', 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map(JSON.parse);
  const state = GateState.replay(config, events, from);
  const prefixHash = state.hash();
  const recordedPrefix = from === 0 ? null : audit[from - 1]?.hash ?? null;
  const prefixMatch = from === 0 ? true : recordedPrefix === prefixHash;
  for (let i = from; i < events.length; i++) state.apply(events[i]);
  const finalHash = state.hash();
  const recordedFinal = audit.length > 0 ? audit[audit.length - 1].hash : null;
  const finalMatch = audit.length > 0 ? recordedFinal === finalHash : true;
  io.stdout(
    JSON.stringify({ from, prefixHash, recordedPrefix, prefixMatch, finalHash, recordedFinal, finalMatch }),
  );
  return prefixMatch && finalMatch ? 0 : 1;
}

function cmdCounterexample(a, config, io) {
  const events = a.events ? parseEvents(readFileSync(a.events, 'utf8')) : [];
  if (!a.order) throw new GateError('counterexample requires --order <id>', 64);
  const result = findCounterexample(config, events, a.order);
  io.stdout(JSON.stringify(result, null, 2));
  return result.found ? 0 : 1;
}

export function runMain(argv, io = { stdout: (s) => console.log(s), stderr: (s) => console.error(s) }) {
  try {
    const a = parseArgs(argv);
    const cmd = a._[0];
    if (!['run', 'replay', 'counterexample'].includes(cmd)) {
      io.stderr(
        'usage: cli.js <run|replay|counterexample> --config <dir> [--events f] [--out f] [--breach f] [--audit f] [--from N] [--order id]',
      );
      return 64;
    }
    const config = loadConfig(a.config ?? 'config');
    if (cmd === 'run') return cmdRun(a, config, io);
    if (cmd === 'replay') return cmdReplay(a, config, io);
    return cmdCounterexample(a, config, io);
  } catch (e) {
    if (e instanceof GateError) {
      io.stderr(`error: ${e.message}`);
      return e.exitCode;
    }
    io.stderr(`fatal: ${e.message}`);
    return 1;
  }
}
