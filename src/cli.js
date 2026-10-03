#!/usr/bin/env node
// biospec CLI: add / update / remove / find / scan / rebuild-index / compact
// Error contract: prints the error code (DUP, NOT_FOUND, ...) to stderr and
// exits with a non-zero status (DUP=2, NOT_FOUND=3, other=1).
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Store, StoreError } from './store.js';

const EXIT = { DUP: 2, NOT_FOUND: 3 };

function fail(err) {
  const code = err instanceof StoreError ? err.code : 'ERROR';
  fs.writeSync(2, `${code}: ${err.message}\n`); // sync write: survives process.exit
  process.exit(EXIT[code] ?? 1);
}

function usage() {
  fs.writeSync(
    2,
    [
      'usage: biospec --data <dir> <command> [options]',
      'commands:',
      '  add    --id <id> --type <t> --date <YYYY-MM-DD> --location <loc> --status <s>',
      '  update --id <id> [--type t] [--date d] [--location l] [--status s]',
      '  remove --id <id>',
      '  find   --id <id>',
      '  scan   [--type t] [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
      '  rebuild-index',
      '  compact',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
let command = null;
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('-')) {
    command = argv.splice(i, 1)[0];
    break;
  }
  if (argv[i] === '--data') i++;
}
if (!command) usage();

let args;
try {
  args = parseArgs({
    args: argv,
    options: {
      data: { type: 'string', default: './biospec-data' },
      id: { type: 'string' },
      type: { type: 'string' },
      date: { type: 'string' },
      location: { type: 'string' },
      loc: { type: 'string' },
      status: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  }).values;
} catch (err) {
  fail(err);
}

const location = args.location ?? args.loc;
let store;
try {
  store = Store.open(args.data);
} catch (err) {
  fail(err);
}

try {
  switch (command) {
    case 'add': {
      if (!args.id) throw new StoreError('INVALID', '--id is required');
      store.add({ id: args.id, type: args.type, date: args.date, location, status: args.status });
      process.stdout.write(`${JSON.stringify(store.find(args.id))}\n`);
      break;
    }
    case 'update': {
      if (!args.id) throw new StoreError('INVALID', '--id is required');
      const patch = {};
      if (args.type !== undefined) patch.type = args.type;
      if (args.date !== undefined) patch.date = args.date;
      if (location !== undefined) patch.location = location;
      if (args.status !== undefined) patch.status = args.status;
      store.update(args.id, patch);
      process.stdout.write(`${JSON.stringify(store.find(args.id))}\n`);
      break;
    }
    case 'remove': {
      if (!args.id) throw new StoreError('INVALID', '--id is required');
      store.remove(args.id);
      process.stdout.write(`{"removed":${JSON.stringify(String(args.id))}}\n`);
      break;
    }
    case 'find': {
      if (!args.id) throw new StoreError('INVALID', '--id is required');
      const rec = store.find(args.id);
      if (!rec) throw new StoreError('NOT_FOUND', `no such sample: ${args.id}`);
      process.stdout.write(`${JSON.stringify(rec)}\n`);
      break;
    }
    case 'scan': {
      const rows = store.scan({ type: args.type ?? null, from: args.from ?? null, to: args.to ?? null });
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      break;
    }
    case 'rebuild-index': {
      store.rebuildIndex();
      process.stdout.write('{"rebuilt":["type","date"]}\n');
      break;
    }
    case 'compact': {
      store.compact();
      process.stdout.write('{"compacted":true}\n');
      break;
    }
    default:
      store.close();
      usage();
  }
  store.close();
} catch (err) {
  try {
    store.close();
  } catch {}
  fail(err);
}
