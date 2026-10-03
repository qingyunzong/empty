#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { BiobankStore, StoreError } = require('./src/store');

const USAGE = `biobank - embedded biobank sample store

Usage: node cli.js --db <dir> <command> [options]

Commands:
  add      --id <s> --type <s> --date <YYYY-MM-DD> [--location <s>] [--status <s>]
  update   --id <s> [--type <s>] [--date <d>] [--location <s>] [--status <s>]
  remove   --id <s>
  find     --id <s>
  scan     [--type <s>] [--from <d> --to <d>]
  rebuild-index
  compact
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

// Runs one CLI invocation. io: { stdout(line), stderr(line) }.
// Returns the process exit code (0 on success, 1 on error).
async function run(argv, io) {
  const opts = parseArgs(argv);
  const command = opts._[0];
  const dbDir = opts.db || process.env.BIOBANK_DB || path.join(process.cwd(), 'biobank-data');

  if (!command || opts.help) {
    io.stdout(USAGE);
    return command ? 0 : 1;
  }

  const store = new BiobankStore(dbDir);
  try {
    switch (command) {
      case 'add': {
        await store.add({
          id: opts.id,
          type: opts.type,
          date: opts.date,
          location: opts.location ?? '',
          status: opts.status ?? '',
        });
        io.stdout(JSON.stringify({ ok: true, id: opts.id }));
        break;
      }
      case 'update': {
        const patch = {};
        for (const k of ['type', 'date', 'location', 'status']) {
          if (opts[k] !== undefined) patch[k] = opts[k];
        }
        await store.update(opts.id, patch);
        io.stdout(JSON.stringify({ ok: true, id: opts.id }));
        break;
      }
      case 'remove': {
        await store.remove(opts.id);
        io.stdout(JSON.stringify({ ok: true, id: opts.id }));
        break;
      }
      case 'find': {
        const found = store.find(opts.id);
        if (!found) {
          throw new StoreError('NOT_FOUND', `no such sample: ${opts.id}`);
        }
        io.stdout(JSON.stringify(found));
        break;
      }
      case 'scan': {
        const rows = opts.type !== undefined
          ? store.scanByType(opts.type)
          : store.scanByDateRange(opts.from, opts.to);
        io.stdout(JSON.stringify({ count: rows.length }));
        for (const row of rows) io.stdout(JSON.stringify(row));
        break;
      }
      case 'rebuild-index': {
        await store.rebuildIndex();
        io.stdout(JSON.stringify({ ok: true, rebuilt: ['by_type', 'by_date'] }));
        break;
      }
      case 'compact': {
        await store.compact();
        io.stdout(JSON.stringify({ ok: true, generation: store.generation }));
        break;
      }
      default:
        io.stderr(`ERROR UNKNOWN_COMMAND ${command}`);
        io.stdout(USAGE);
        return 1;
    }
  } catch (err) {
    const code = err && err.code ? err.code : 'INTERNAL';
    io.stderr(`ERROR ${code} ${err.message}`);
    return 1;
  } finally {
    await store.close();
  }
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  }).then((code) => process.exit(code));
}

module.exports = { run };
