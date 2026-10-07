#!/usr/bin/env node
// oee-cli: offline OEE collection/merge for filling-line terminals.
//
//   oee-cli ingest --state S.json events.jsonl [--window-start W --window-end E --max-skew K]
//   oee-cli merge  --state out.json a.json b.json [more.json ...]
//   oee-cli oee    --state S.json --planned SEC --ideal-rate UNITS_PER_SEC [--window-start W --window-end E]
//   oee-cli hold   --state S.json
//   oee-cli digest --state S.json [--bucket MS]
//   oee-cli repair --state S.json --peer P.json [--bucket MS] [--window-start W --window-end E --max-skew K]
//
// Exit codes: 0 ok | 1 internal | 2 usage/validation | 10 negative count | 11 hold events in final state
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  emptyState, applyEvent, mergeAll, NegativeCountError, ValidationError, pendingHolds,
} from './state.js';
import { computeOee } from './oee.js';
import { summarize, repair } from './antientropy.js';

export const EXIT_NEGATIVE = 10;
export const EXIT_HOLD = 11;

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const out = (obj) => stdout(JSON.stringify(obj, null, 2) + '\n');

  const fail = (message, code = 2) => { throw new CliError(message, code); };
  const loadState = (path) => {
    if (!existsSync(path)) return emptyState();
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      fail(`cannot read state ${path}: ${err.message}`);
    }
  };
  const saveState = (path, state) => writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
  const readJsonl = (path) => {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      fail(`cannot read ${path}: ${err.message}`);
    }
    const events = [];
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        fail(`${path}:${i + 1}: invalid JSON`);
      }
    });
    return events;
  };
  const num = (value, name) => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n)) fail(`--${name} must be a number`);
    return n;
  };
  const windowOpts = (values) => {
    const opts = {};
    if (values['window-start'] !== undefined) opts.windowStart = num(values['window-start'], 'window-start');
    if (values['window-end'] !== undefined) opts.windowEnd = num(values['window-end'], 'window-end');
    if (values['max-skew'] !== undefined) opts.maxSkew = num(values['max-skew'], 'max-skew');
    if ((opts.windowStart === undefined) !== (opts.windowEnd === undefined)) {
      fail('--window-start and --window-end must be given together');
    }
    return opts;
  };

  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'ingest': {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true,
          options: {
            state: { type: 'string' }, 'window-start': { type: 'string' },
            'window-end': { type: 'string' }, 'max-skew': { type: 'string' },
          },
        });
        if (!values.state || positionals.length !== 1) fail('usage: ingest --state S.json events.jsonl [--window-start W --window-end E --max-skew K]');
        const state = loadState(values.state);
        const opts = windowOpts(values);
        for (const event of readJsonl(positionals[0])) applyEvent(state, event, opts);
        saveState(values.state, state);
        out({ ingested: Object.keys(state.journal).length, holds: Object.keys(state.holds).length });
        return 0;
      }
      case 'merge': {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true, options: { state: { type: 'string' } },
        });
        if (!values.state || positionals.length < 2) fail('usage: merge --state out.json a.json b.json [...]');
        const merged = mergeAll(positionals.map(loadState));
        saveState(values.state, merged);
        out({ merged: positionals.length, events: Object.keys(merged.journal).length });
        return 0;
      }
      case 'oee': {
        const { values } = parseArgs({
          args: rest,
          options: {
            state: { type: 'string' }, planned: { type: 'string' }, 'ideal-rate': { type: 'string' },
            'window-start': { type: 'string' }, 'window-end': { type: 'string' },
          },
        });
        if (!values.state || values.planned === undefined || values['ideal-rate'] === undefined) {
          fail('usage: oee --state S.json --planned SEC --ideal-rate UNITS_PER_SEC [--window-start W --window-end E]');
        }
        const result = computeOee(loadState(values.state), {
          plannedTime: num(values.planned, 'planned'),
          idealRate: num(values['ideal-rate'], 'ideal-rate'),
          ...windowOpts(values),
        });
        out(result);
        if (result.pending.length > 0) {
          stderr(`error: ${result.pending.length} hold event(s) pending; final state not settled\n`);
          return EXIT_HOLD;
        }
        return 0;
      }
      case 'hold': {
        const { values } = parseArgs({ args: rest, options: { state: { type: 'string' } } });
        if (!values.state) fail('usage: hold --state S.json');
        const pending = pendingHolds(loadState(values.state));
        out({ pending, count: pending.length });
        return 0;
      }
      case 'digest': {
        const { values } = parseArgs({
          args: rest, options: { state: { type: 'string' }, bucket: { type: 'string' } },
        });
        if (!values.state) fail('usage: digest --state S.json [--bucket MS]');
        const bucketMs = values.bucket !== undefined ? num(values.bucket, 'bucket') : 60000;
        out(summarize(loadState(values.state), bucketMs));
        return 0;
      }
      case 'repair': {
        const { values } = parseArgs({
          args: rest,
          options: {
            state: { type: 'string' }, peer: { type: 'string' }, bucket: { type: 'string' },
            'window-start': { type: 'string' }, 'window-end': { type: 'string' }, 'max-skew': { type: 'string' },
          },
        });
        if (!values.state || !values.peer) fail('usage: repair --state S.json --peer P.json [--bucket MS]');
        const state = loadState(values.state);
        const peer = loadState(values.peer);
        const opts = windowOpts(values);
        if (values.bucket !== undefined) opts.bucketMs = num(values.bucket, 'bucket');
        const applied = repair(state, peer, opts);
        saveState(values.state, state);
        out({ applied, count: applied.length });
        return 0;
      }
      default:
        fail('commands: ingest | merge | oee | hold | digest | repair');
    }
  } catch (err) {
    if (err instanceof NegativeCountError) {
      stderr(`error: ${err.message}\n`);
      return EXIT_NEGATIVE;
    }
    if (err instanceof ValidationError || err instanceof CliError) {
      stderr(`error: ${err.message}\n`);
      return err.code ?? 2;
    }
    stderr(`error: ${err.message ?? String(err)}\n`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
