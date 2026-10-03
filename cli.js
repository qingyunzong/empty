#!/usr/bin/env node
// Usage: node cli.js check <history.json> [--initial account=balance ...]
//
// Exit codes:
//   0 - history is well-formed; result (linearizable true/false) on stdout.
//   1 - INVALID_HISTORY (bad structure, inverted times, negative amounts,
//       duplicate opIds, ...); error on stderr.
//   2 - usage error.

import { readFile } from 'node:fs/promises';
import { validateHistory, InvalidHistory } from './src/validate.js';
import { checkLinearizable } from './src/checker.js';

function usage() {
  console.error('usage: node cli.js check <history.json> [--initial account=balance ...]');
}

function parseInitial(flags) {
  const initial = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== '--initial') {
      throw new Error(`unknown argument: ${flags[i]}`);
    }
    const spec = flags[++i];
    if (!spec) throw new Error('--initial requires account=balance');
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error(`invalid --initial spec: ${spec}`);
    const account = spec.slice(0, eq);
    const balance = Number(spec.slice(eq + 1));
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error(`invalid initial balance in: ${spec}`);
    }
    initial[account] = balance;
  }
  return initial;
}

async function main(argv) {
  const [command, file, ...flags] = argv;
  if (command !== 'check' || !file) {
    usage();
    process.exitCode = 2;
    return;
  }

  let initial;
  try {
    initial = parseInitial(flags);
  } catch (err) {
    console.error(err.message);
    usage();
    process.exitCode = 2;
    return;
  }

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    console.error(JSON.stringify({ error: 'INVALID_HISTORY', message: `cannot read file: ${file}` }));
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(JSON.stringify({ error: 'INVALID_HISTORY', message: `invalid JSON: ${err.message}` }));
    process.exitCode = 1;
    return;
  }

  let ops;
  try {
    ops = validateHistory(data);
  } catch (err) {
    if (err instanceof InvalidHistory) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const result = checkLinearizable(ops, { initial });
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2));
