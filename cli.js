#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ClearingEngine, verifyReport } from './lib/engine.js';
import { ClearingError, EXIT_CODES } from './lib/errors.js';

const USAGE = `clearing-daycut — clearing house day-cut settlement

Usage:
  node cli.js settle --tx FILE --tz FILE --cal FILE [--out FILE]
  node cli.js verify --tx FILE --tz FILE --cal FILE --report FILE

Commands:
  settle   Map transactions to settlement days, emit per-account daily nets,
           pending reasons and a verifiable certificate (JSON).
  verify   Replay inputs and check the report's certificate hash.

Exit codes:
  0  success            10 E_TZ_UNKNOWN   12 E_OVERLAP
  1  generic error      11 E_GAP          13 E_ORDER
  6  certificate mismatch (verify)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${key}`);
      args[key] = next;
      i += 1;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function loadInputs(args) {
  for (const k of ['tx', 'tz', 'cal']) {
    if (!args[k]) throw new Error(`missing --${k} FILE`);
  }
  return {
    transactions: readJson(args.tx),
    tzTable: readJson(args.tz),
    calendar: readJson(args.cal),
  };
}

// Programmatic entry: returns { code, stdout, stderr }.
export function runCli(argv) {
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(rest);

    if (command === 'settle') {
      const inputs = loadInputs(args);
      const engine = new ClearingEngine({ tzTable: inputs.tzTable, calendar: inputs.calendar });
      const report = engine.settle(inputs.transactions);
      const out = `${JSON.stringify(report, null, 2)}\n`;
      if (args.out) {
        writeFileSync(args.out, out);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: out, stderr: '' };
    }

    if (command === 'verify') {
      const inputs = loadInputs(args);
      if (!args.report) throw new Error('missing --report FILE');
      const report = readJson(args.report);
      const ok = verifyReport(inputs, report);
      return {
        code: ok ? 0 : 6,
        stdout: `${JSON.stringify({ verified: ok, certificateHash: report?.certificate?.certificateHash ?? null })}\n`,
        stderr: '',
      };
    }

    const known = command === undefined || command === 'help' || command === '--help';
    return { code: known ? 0 : 1, stdout: '', stderr: USAGE };
  } catch (err) {
    if (err instanceof ClearingError) {
      return {
        code: EXIT_CODES[err.code] ?? 1,
        stdout: '',
        stderr: `${JSON.stringify({ error: err.code, message: err.message, details: err.details ?? null })}\n`,
      };
    }
    return { code: 1, stdout: '', stderr: `${JSON.stringify({ error: 'E_INTERNAL', message: err.message })}\n` };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
