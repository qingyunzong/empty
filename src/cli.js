import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex } from './config.js';
import { parseEvents } from './events.js';
import { foldEvents } from './state.js';
import { buildSchedule } from './schedule.js';
import { findCounterexample } from './counterexample.js';
import { stateHash } from './serialize.js';
import { GateError, EXIT } from './errors.js';

export const USAGE = `gate - offline night-shift gate interpreter

usage:
  gate run --config plant.json --events release.jsonl [--date YYYY-MM-DD] [--outdir .]
  gate replay --config plant.json --events release.jsonl [--from N] [--to M]
  gate counterexample --config plant.json --events release.jsonl --order WO-1 [--depth 3]
  gate validate --config plant.json --events release.jsonl

exit codes: 0 ok, 2 usage/io, 5 time backwards, 6 negative capability, 7 unknown material
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadInputs(args) {
  if (!args.config || !args.events) {
    throw new GateError('--config and --events are required', EXIT.USAGE);
  }
  let config;
  let eventsText;
  try {
    config = JSON.parse(readFileSync(args.config, 'utf8'));
    eventsText = readFileSync(args.events, 'utf8');
  } catch (err) {
    throw new GateError(`cannot read inputs: ${err.message}`, EXIT.USAGE);
  }
  const idx = buildIndex(config);
  const events = parseEvents(eventsText);
  return { idx, events };
}

function defaultDate(events) {
  if (events.length === 0) return new Date().toISOString().slice(0, 10);
  return new Date(events[events.length - 1].ts).toISOString().slice(0, 10);
}

function cmdRun(args, out) {
  const { idx, events } = loadInputs(args);
  const state = foldEvents(events, idx);
  const date = args.date ?? defaultDate(events);
  const { schedule, breaches } = buildSchedule(idx, state, date);
  const outdir = args.outdir ?? '.';
  mkdirSync(outdir, { recursive: true });
  writeFileSync(join(outdir, 'schedule.out.json'), `${JSON.stringify(schedule, null, 2)}\n`);
  writeFileSync(
    join(outdir, 'breach.json'),
    `${JSON.stringify({ date, stateHash: schedule.stateHash, breaches }, null, 2)}\n`,
  );
  const compLines = state.compensations.map((c) => JSON.stringify(c)).join('\n');
  writeFileSync(join(outdir, 'compensation.jsonl'), compLines ? `${compLines}\n` : '');
  out(
    JSON.stringify({
      date,
      events: state.seq,
      stateHash: schedule.stateHash,
      scheduled: schedule.shifts.reduce((n, s) => n + s.orders.length, 0),
      breaches: breaches.length,
      compensations: state.compensations.length,
    }),
  );
}

function cmdReplay(args, out) {
  const { idx, events } = loadInputs(args);
  const from = args.from === undefined ? 0 : Number(args.from);
  const to = args.to === undefined ? events.length : Number(args.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > events.length) {
    throw new GateError(`invalid --from/--to range (events: ${events.length})`, EXIT.USAGE);
  }
  // Rebuild the checkpoint by folding the prefix, then continue with the suffix.
  const state = foldEvents(events.slice(0, from), idx);
  foldEvents(events.slice(from, to), idx, state);
  out(JSON.stringify({ from, to, events: state.seq, stateHash: stateHash(state) }));
}

function cmdCounterexample(args, out) {
  const { idx, events } = loadInputs(args);
  if (!args.order) throw new GateError('--order is required', EXIT.USAGE);
  const depth = args.depth === undefined ? 3 : Number(args.depth);
  const result = findCounterexample(idx, events, args.order, depth);
  if (!result) {
    out(JSON.stringify({ order: args.order, sequence: null, reason: 'not releasable in base state, or no flip within depth' }));
    return;
  }
  out(JSON.stringify(result, null, 2));
}

function cmdValidate(args, out) {
  const { idx, events } = loadInputs(args);
  const state = foldEvents(events, idx);
  out(JSON.stringify({ ok: true, events: state.seq, stateHash: stateHash(state) }));
}

// Returns the process exit code. io.out / io.err capture output in tests.
export function runCli(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  try {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    switch (cmd) {
      case 'run':
        cmdRun(args, out);
        return EXIT.OK;
      case 'replay':
        cmdReplay(args, out);
        return EXIT.OK;
      case 'counterexample':
        cmdCounterexample(args, out);
        return EXIT.OK;
      case 'validate':
        cmdValidate(args, out);
        return EXIT.OK;
      case undefined:
      case 'help':
        err(USAGE);
        return EXIT.OK;
      default:
        err(USAGE);
        return EXIT.USAGE;
    }
  } catch (error) {
    if (error instanceof GateError) {
      err(`gate: ${error.message}`);
      return error.code;
    }
    err(`gate: unexpected error: ${error.stack ?? error.message}`);
    return EXIT.GENERIC;
  }
}
