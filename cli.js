#!/usr/bin/env node
// Usage:
//   node cli.js diff <left.jsonl> <right.jsonl> [--k 5] [--budget 100000]
//   node cli.js verify <left.jsonl> <right.jsonl> <certificate.json>
//
// Exit codes: 0 balanced / certificate valid; 1 differences found with
// repair scripts; 2 error (DUP_ID, CURRENCY_MIX, SEARCH_BOUND,
// CERT_INVALID, INPUT_INVALID, INPUT_TOO_LARGE).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonl, prepareLedger, diffLedgers, verifyCertificate, ReconError } from './src/index.js';

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--k') {
      flags.k = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === '--budget') {
      flags.budget = Number(args[i + 1]);
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

function loadLedger(path, side) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ReconError('INPUT_INVALID', `cannot read ${side} file: ${path}`);
  }
  return prepareLedger(parseJsonl(text, side), side);
}

// Runs the CLI and returns the exit code; output is delivered through the
// injected `write` so tests can exercise the CLI in-process.
export function run(argv, { write }) {
  const emit = (payload, exitCode) => {
    write(`${JSON.stringify(payload, null, 2)}\n`);
    return exitCode;
  };
  const emitError = (code, message) => emit(
    { balanced: false, scripts: [], certificate: null, error: { code, message } }, 2,
  );
  const [command, ...rest] = argv;
  try {
    if (command === 'diff') {
      const { positional, flags } = parseFlags(rest);
      if (positional.length !== 2) {
        return emitError('INPUT_INVALID', 'usage: node cli.js diff <left.jsonl> <right.jsonl> [--k 5] [--budget N]');
      }
      const k = flags.k ?? 5;
      if (!Number.isInteger(k) || k < 0) return emitError('INPUT_INVALID', '--k must be a non-negative integer');
      const left = loadLedger(positional[0], 'left');
      const right = loadLedger(positional[1], 'right');
      const result = diffLedgers(left, right, { k, budget: flags.budget });
      return emit(result, result.error ? 2 : result.balanced ? 0 : 1);
    }
    if (command === 'verify') {
      const { positional } = parseFlags(rest);
      if (positional.length !== 3) {
        return emitError('INPUT_INVALID', 'usage: node cli.js verify <left.jsonl> <right.jsonl> <certificate.json>');
      }
      const left = loadLedger(positional[0], 'left');
      const right = loadLedger(positional[1], 'right');
      const cert = JSON.parse(readFileSync(positional[2], 'utf8'));
      verifyCertificate(left, right, cert);
      return emit({ valid: true }, 0);
    }
    return emitError('INPUT_INVALID', 'usage: node cli.js <diff|verify> ...');
  } catch (e) {
    if (e instanceof ReconError) return emitError(e.code, e.message);
    throw e;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = run(process.argv.slice(2), { write: (s) => process.stdout.write(s) });
  process.exitCode = code;
}
