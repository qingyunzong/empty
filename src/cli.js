#!/usr/bin/env node
'use strict';

const { Store, StoreError } = require('./store');

const EXIT = { ERROR: 1, INVALID: 2, NOT_FOUND: 3, CONFLICT: 4 };

const USAGE = `obs-store - embedded transactional MVCC store

usage:
  obs-store init <dir>
  obs-store put <dir> <key> <value>
  obs-store get <dir> <key> [--at <version>]
  obs-store del <dir> <key>
  obs-store scan <dir> [--prefix <p>] [--at <version>]
  obs-store history <dir> <key>
`;

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(EXIT[code] || EXIT.ERROR);
}

function parseFlags(args, allowed) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (!allowed.includes(a)) fail('INVALID', `unknown flag: ${a}`);
      const v = args[++i];
      if (v === undefined) fail('INVALID', `missing value for ${a}`);
      flags[a.slice(2)] = v;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function parseVersion(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) fail('INVALID', `--at must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      const { pos, flags } = parseFlags(rest, []);
      if (pos.length !== 1 || Object.keys(flags).length) fail('INVALID', 'usage: init <dir>');
      Store.init(pos[0]);
      return;
    }
    case 'put': {
      const { pos } = parseFlags(rest, []);
      if (pos.length !== 3) fail('INVALID', 'usage: put <dir> <key> <value>');
      const store = Store.open(pos[0]);
      const txn = store.begin();
      txn.put(pos[1], pos[2]);
      const { version } = txn.commit();
      store.close();
      process.stdout.write(`v${version}\n`);
      return;
    }
    case 'get': {
      const { pos, flags } = parseFlags(rest, ['--at']);
      if (pos.length !== 2) fail('INVALID', 'usage: get <dir> <key> [--at <version>]');
      const at = parseVersion(flags.at);
      const store = Store.open(pos[0]);
      const value = store.get(pos[1], at === undefined ? {} : { at });
      store.close();
      process.stdout.write(`${value}\n`);
      return;
    }
    case 'del': {
      const { pos } = parseFlags(rest, []);
      if (pos.length !== 2) fail('INVALID', 'usage: del <dir> <key>');
      const store = Store.open(pos[0]);
      const txn = store.begin();
      txn.delete(pos[1]);
      const { version } = txn.commit();
      store.close();
      process.stdout.write(`v${version}\n`);
      return;
    }
    case 'scan': {
      const { pos, flags } = parseFlags(rest, ['--prefix', '--at']);
      if (pos.length !== 1) fail('INVALID', 'usage: scan <dir> [--prefix <p>] [--at <version>]');
      const at = parseVersion(flags.at);
      const store = Store.open(pos[0]);
      const opts = {};
      if (flags.prefix !== undefined) opts.prefix = flags.prefix;
      if (at !== undefined) opts.at = at;
      for (const [k, v] of store.scan(opts)) {
        process.stdout.write(`${k}\t${v}\n`);
      }
      store.close();
      return;
    }
    case 'history': {
      const { pos } = parseFlags(rest, []);
      if (pos.length !== 2) fail('INVALID', 'usage: history <dir> <key>');
      const store = Store.open(pos[0]);
      for (const e of store.history(pos[1])) {
        process.stdout.write(`v${e.version}\t${e.value === null ? '<deleted>' : e.value}\n`);
      }
      store.close();
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(USAGE);
      return;
    default:
      fail('INVALID', `unknown command: ${cmd}\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof StoreError) {
    fail(err.code, err.message);
  }
  throw err;
}
