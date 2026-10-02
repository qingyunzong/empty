#!/usr/bin/env node
import fs from 'node:fs';
import { openStore, StoreError } from './src/store.js';

const EXIT_CODES = { NO_TARGET: 2, CYCLE: 3, USAGE: 64 };

// Synchronous writes: async pipe writes can be lost when the CLI runs as a
// sandboxed subprocess, so all user-facing output goes through writeSync.
function out(line) {
  fs.writeSync(1, line);
}

function errOut(line) {
  fs.writeSync(2, line);
}

function usage() {
  errOut(
    [
      'Usage: node cli.js <command> [--data DIR] [options]',
      '',
      'Commands:',
      '  correct  --target NAME --value V [--corrects ID] [--id ID] [--time MS]',
      '  resolve  --target NAME',
      '  view-at  --target NAME --time MS',
      '  chain    --target NAME',
      '  range    --from MS --to MS',
      '  verify',
      '',
      'Errors: NO_TARGET (exit 2), CYCLE (exit 3)',
    ].join('\n') + '\n',
  );
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function required(flags, key) {
  if (flags[key] === undefined || flags[key] === true) {
    throw new StoreError('USAGE', `missing required option --${key}`);
  }
  return flags[key];
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function print(rec) {
  out(`${JSON.stringify(rec)}\n`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!cmd || flags.help) {
    usage();
    process.exit(cmd ? 0 : 64);
  }
  const dir = typeof flags.data === 'string' ? flags.data : 'observatory-data';
  const options = {};
  if (process.env.STORE_FLUSH_EVERY !== undefined) {
    options.flushEvery = Number(process.env.STORE_FLUSH_EVERY);
  }
  const store = openStore(dir, options);
  try {
    switch (cmd) {
      case 'correct': {
        print(
          store.commit({
            id: typeof flags.id === 'string' ? flags.id : undefined,
            target: typeof flags.target === 'string' ? flags.target : undefined,
            value: flags.value === undefined ? undefined : parseValue(flags.value),
            corrects: typeof flags.corrects === 'string' ? flags.corrects : null,
            t: flags.time !== undefined ? Number(flags.time) : undefined,
          }),
        );
        break;
      }
      case 'resolve': {
        const target = required(flags, 'target');
        const rec = store.resolve(target);
        if (!rec) throw new StoreError('NO_TARGET', `unknown target "${target}"`);
        print(rec);
        break;
      }
      case 'view-at': {
        const target = required(flags, 'target');
        const t = Number(required(flags, 'time'));
        const rec = store.viewAt(target, t);
        if (!rec) {
          throw new StoreError('NO_TARGET', `no record for target "${target}" at t=${t}`);
        }
        print(rec);
        break;
      }
      case 'chain': {
        const target = required(flags, 'target');
        const list = store.chain(target);
        if (list.length === 0) throw new StoreError('NO_TARGET', `unknown target "${target}"`);
        for (const rec of list) print(rec);
        break;
      }
      case 'range': {
        const from = Number(required(flags, 'from'));
        const to = Number(required(flags, 'to'));
        for (const rec of store.range(from, to)) print(rec);
        break;
      }
      case 'verify': {
        const res = store.verify();
        out(res.rebuilt ? 'REBUILT\n' : 'OK\n');
        break;
      }
      default:
        usage();
        process.exit(64);
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (err) {
  if (err instanceof StoreError) {
    errOut(`${err.code}: ${err.message}\n`);
    process.exit(EXIT_CODES[err.code] ?? 1);
  }
  errOut(`ERROR: ${err.message}\n`);
  process.exit(1);
}
