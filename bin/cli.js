#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const { Engine, EngineError } = require('../src/engine');

const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NO_TARGET: 3,
  CYCLE: 4,
  NOT_FOUND: 5,
  DUP_ID: 6,
};

function usage() {
  return `obs-corrections - observatory correction ledger

usage:
  cli.js correct  --db DIR --target NAME --value V [--corrects ID] [--id ID] [--ts N]
  cli.js resolve  --db DIR (--target NAME | --id ID)
  cli.js view-at  --db DIR (--target NAME | --id ID) --at N
  cli.js chain    --db DIR (--target NAME | --id ID)
  cli.js verify   --db DIR

error codes (stderr + exit code):
  NO_TARGET(${EXIT.NO_TARGET}) correction of a nonexistent record
  CYCLE(${EXIT.CYCLE})     cyclic correction reference
  NOT_FOUND(${EXIT.NOT_FOUND}) unknown record/target for resolve/view-at/chain
  DUP_ID(${EXIT.DUP_ID})     record id already committed`;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function fail(err) {
  if (err instanceof EngineError && EXIT[err.code] !== undefined) {
    // Synchronous write: process.exit can truncate buffered async stderr.
    fs.writeSync(2, `${err.code}: ${err.message}\n`);
    process.exit(EXIT[err.code]);
  }
  fs.writeSync(2, `ERROR: ${err.message}\n`);
  process.exit(EXIT.GENERIC);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(usage() + '\n');
    process.exit(cmd ? EXIT.OK : EXIT.USAGE);
  }

  const common = {
    db: { type: 'string' },
    target: { type: 'string' },
    id: { type: 'string' },
  };
  let opts;
  try {
    if (cmd === 'correct') {
      ({ values: opts } = parseArgs({
        args: rest,
        options: { ...common, value: { type: 'string' }, corrects: { type: 'string' }, ts: { type: 'string' } },
      }));
    } else if (cmd === 'view-at') {
      ({ values: opts } = parseArgs({
        args: rest,
        options: { ...common, at: { type: 'string' } },
      }));
    } else if (cmd === 'resolve' || cmd === 'chain') {
      ({ values: opts } = parseArgs({ args: rest, options: common }));
    } else if (cmd === 'verify') {
      ({ values: opts } = parseArgs({ args: rest, options: { db: { type: 'string' } } }));
    } else {
      fs.writeSync(2, usage() + '\n');
      process.exit(EXIT.USAGE);
    }
  } catch (err) {
    fs.writeSync(2, `USAGE: ${err.message}\n`);
    process.exit(EXIT.USAGE);
  }

  if (!opts.db) {
    fs.writeSync(2, 'USAGE: --db is required\n');
    process.exit(EXIT.USAGE);
  }

  const engine = Engine.open(opts.db);
  try {
    if (cmd === 'correct') {
      if (opts.target === undefined || opts.value === undefined) {
        fs.writeSync(2, 'USAGE: correct requires --target and --value\n');
        process.exit(EXIT.USAGE);
      }
      const rec = engine.commit({
        id: opts.id,
        target: opts.target,
        value: parseValue(opts.value),
        corrects: opts.corrects ?? null,
        ts: opts.ts !== undefined ? Number(opts.ts) : undefined,
      });
      process.stdout.write(JSON.stringify(rec) + '\n');
    } else if (cmd === 'resolve') {
      const sel = select(opts);
      process.stdout.write(JSON.stringify(engine.resolve(sel)) + '\n');
    } else if (cmd === 'view-at') {
      if (opts.at === undefined) {
        fs.writeSync(2, 'USAGE: view-at requires --at\n');
        process.exit(EXIT.USAGE);
      }
      const sel = select(opts);
      process.stdout.write(JSON.stringify(engine.viewAt({ ...sel, at: Number(opts.at) })) + '\n');
    } else if (cmd === 'chain') {
      const sel = select(opts);
      const startId = sel.id !== null ? sel.id : engine.resolve(sel).id;
      const links = engine.chain(startId);
      for (const rec of links) process.stdout.write(JSON.stringify(rec) + '\n');
    } else if (cmd === 'verify') {
      const res = engine.verify();
      if (res.repaired) {
        process.stdout.write(`REBUILT: ${res.problems.join('; ')}\n`);
      } else {
        process.stdout.write('OK\n');
      }
    }
  } catch (err) {
    fail(err);
  } finally {
    engine.close();
  }
}

function select(opts) {
  if (opts.id !== undefined) return { id: opts.id };
  if (opts.target !== undefined) return { target: opts.target };
  fs.writeSync(2, 'USAGE: one of --id or --target is required\n');
  process.exit(2);
}

main(process.argv.slice(2));
