#!/usr/bin/env node
// starcats CLI: reads a JSONL event stream (file argument or stdin), applies
// each event, and prints one JSON result per line.
//
// Exit codes: 0 = all solves SAT (or no solve), 2 = invalid input,
//             3 = some solve was UNSAT, 4 = some solve was PENDING.
// PENDING (budget exhausted) is never reported as UNSAT; PENDING outranks
// UNSAT for the exit code because the final answer is still unknown.

import { readFileSync } from 'node:fs';
import { Catalog, CatalogError } from './catalog.js';

const USAGE = `usage: starcats [events.jsonl] [--coords N] [--mags N] [--creds K] [--capacity C]
  Reads JSONL events (add_obs, retract_obs, correct_obs, checkpoint, undo_to,
  solve) from the file or stdin and prints one JSON result per line.
  Exit codes: 0 ok, 2 invalid input, 3 UNSAT, 4 PENDING (budget exceeded).`;

// Note: we never call process.exit(); we set process.exitCode and let the
// process drain stdout naturally, so piped output is never truncated.

function parseArgs(argv) {
  const limits = {};
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return null;
    }
    if (arg.startsWith('--')) {
      const key = { '--coords': 'coords', '--mags': 'mags', '--creds': 'creds', '--capacity': 'capacity' }[arg];
      const value = Number(argv[i + 1]);
      if (!key || !Number.isInteger(value) || value < 1) {
        console.log(JSON.stringify({ type: 'error', error: { code: 'INVALID_ARGS', message: `bad option: ${arg} ${argv[i + 1] ?? ''}` } }));
        process.exitCode = 2;
        return null;
      }
      limits[key] = value;
      i += 1;
    } else if (file === null) {
      file = arg;
    } else {
      console.log(JSON.stringify({ type: 'error', error: { code: 'INVALID_ARGS', message: `unexpected argument: ${arg}` } }));
      process.exitCode = 2;
      return null;
    }
  }
  return { file, limits };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) return;
  const { file, limits } = args;

  let input;
  try {
    input = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  } catch (error) {
    console.log(JSON.stringify({ type: 'error', error: { code: 'INPUT_ERROR', message: error.message } }));
    process.exitCode = 2;
    return;
  }

  const catalog = new Catalog(limits);
  let sawPending = false;
  let sawUnsat = false;
  const lines = input.split('\n');

  for (let seq = 0; seq < lines.length; seq += 1) {
    const line = lines[seq].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.log(JSON.stringify({ seq, type: 'error', error: { code: 'INVALID_JSON', message: 'line is not valid JSON' } }));
      process.exitCode = 2;
      return;
    }
    let out;
    try {
      out = catalog.applyEvent(event);
    } catch (error) {
      if (error instanceof CatalogError) {
        console.log(JSON.stringify({ seq, type: 'error', error: { code: error.code, message: error.message } }));
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    if (out.type === 'solve_result') {
      delete out.coreObs; // internal objects; the public core is in `core`
      if (out.status === 'PENDING') sawPending = true;
      if (out.status === 'UNSAT') sawUnsat = true;
    }
    console.log(JSON.stringify({ seq, ...out }));
  }

  process.exitCode = sawPending ? 4 : sawUnsat ? 3 : 0;
}

main();
