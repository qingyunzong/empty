#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseLog } from './eventlog.js';
import { replay, audit } from './replay.js';
import { planUndo } from './undo.js';
import { ReplayError, EXIT } from './errors.js';

const USAGE = `toollife - offline tool-life replay

usage:
  toollife replay <log.jsonl|->     replay events; exit 12 over budget, 13 illegal transition, 14 conflict
  toollife undo <log.jsonl|-> <measureId>   plan compensation of a false measurement (recovery path only)
  toollife budget <log.jsonl|->     print layered budget usage; exit 12 if any layer exceeded
  toollife audit <log.jsonl|->      verify causal/budget/transition integrity of the log
`;

function readInput(path) {
  return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
}

function out(x) {
  process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
}

function fail(e) {
  if (e instanceof ReplayError) {
    process.stderr.write(`${JSON.stringify({ error: { kind: e.kind, message: e.message, ...e.details } }, null, 2)}\n`);
    process.exitCode = e.exitCode;
  } else {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  }
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'replay': {
      if (args.length !== 1) throw new ReplayError('VALIDATION', 'replay expects exactly one log file');
      const events = parseLog(readInput(args[0]), args[0]);
      const result = replay(events);
      out(result);
      process.exitCode = result.exitCode;
      break;
    }
    case 'undo': {
      if (args.length !== 2) throw new ReplayError('VALIDATION', 'undo expects a log file and a measure event id');
      const events = parseLog(readInput(args[0]), args[0]);
      out(planUndo(events, args[1]));
      break;
    }
    case 'budget': {
      if (args.length !== 1) throw new ReplayError('VALIDATION', 'budget expects exactly one log file');
      const events = parseLog(readInput(args[0]), args[0]);
      const result = replay(events);
      out({ budgets: result.budgets, overspend: result.overspend });
      process.exitCode = result.exitCode;
      break;
    }
    case 'audit': {
      if (args.length !== 1) throw new ReplayError('VALIDATION', 'audit expects exactly one log file');
      const events = parseLog(readInput(args[0]), args[0]);
      const { report, exitCode } = audit(events);
      out(report);
      process.exitCode = exitCode;
      break;
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(USAGE);
      process.exitCode = cmd === undefined ? EXIT.VALIDATION : EXIT.OK;
      break;
    default:
      process.stderr.write(`unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);
      process.exitCode = EXIT.VALIDATION;
  }
}

try {
  main();
} catch (e) {
  fail(e);
}
