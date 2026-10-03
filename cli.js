#!/usr/bin/env node
'use strict';

const { Store } = require('./src/store');
const { StoreError, INVALID } = require('./src/errors');

const USAGE = `Usage: kvstore [--dir <path>] <command> [args]

Commands:
  init                      Initialize a store directory
  put <key> <value>         Set key to value
  get <key> [--at <ver>]    Read key (optionally at a historical version)
  del <key>                 Delete key
  scan [--at <ver>]         List all key/value pairs (sorted by key)
  history <key>             List all committed versions of a key
`;

function parseArgs(argv) {
  const opts = { dir: './kvstore-data', at: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      opts.dir = argv[++i];
      if (opts.dir === undefined) throw new StoreError(INVALID, '--dir requires a value');
    } else if (arg === '--at') {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new StoreError(INVALID, '--at requires a non-negative integer version');
      }
      opts.at = Number(raw);
    } else if (arg.startsWith('--')) {
      throw new StoreError(INVALID, `unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function main(argv) {
  const { opts, positional } = parseArgs(argv);
  const [command, ...args] = positional;
  if (!command) throw new StoreError(INVALID, 'missing command');

  if (command === 'init') {
    Store.init(opts.dir);
    console.log(`initialized store at ${opts.dir}`);
    return;
  }

  const store = new Store(opts.dir);
  try {
    switch (command) {
      case 'put': {
        if (args.length !== 2) throw new StoreError(INVALID, 'put requires <key> <value>');
        const txn = store.begin();
        txn.put(args[0], args[1]);
        const { version } = txn.commit();
        console.log(`OK version=${version}`);
        break;
      }
      case 'get': {
        if (args.length !== 1) throw new StoreError(INVALID, 'get requires <key>');
        const value = opts.at === undefined ? store.get(args[0]) : store.get(args[0], opts.at);
        console.log(value);
        break;
      }
      case 'del': {
        if (args.length !== 1) throw new StoreError(INVALID, 'del requires <key>');
        // Deleting a non-existent key is an error.
        store.get(args[0]);
        const txn = store.begin();
        txn.delete(args[0]);
        const { version } = txn.commit();
        console.log(`OK version=${version}`);
        break;
      }
      case 'scan': {
        if (args.length !== 0) throw new StoreError(INVALID, 'scan takes no arguments');
        const rows = opts.at === undefined ? store.scan() : store.scan(opts.at);
        for (const [key, value] of rows) {
          console.log(`${key}\t${value}`);
        }
        break;
      }
      case 'history': {
        if (args.length !== 1) throw new StoreError(INVALID, 'history requires <key>');
        for (const entry of store.history(args[0])) {
          console.log(`${entry.version}\t${entry.value === null ? 'DELETED' : entry.value}`);
        }
        break;
      }
      default:
        throw new StoreError(INVALID, `unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof StoreError) {
    console.error(`ERROR ${err.code}: ${err.message}`);
    if (err.code === INVALID) process.stderr.write(USAGE);
    process.exit(err.code === 'NOT_FOUND' ? 2 : err.code === 'CONFLICT' ? 3 : 1);
  }
  throw err;
}
