'use strict';

const fs = require('node:fs');
const { Store } = require('./store');
const { PlanError, EXIT_CODES } = require('./errors');

const USAGE = `plan - offline production planning for a single industrial PC

usage: plan <command> [args]

commands:
  init <dir>                              create an empty store
  add <dir> --order '<json>'              append a work order
                                          ({"id","quantity","due","machine"}; @file or @- for stdin)
  list <dir>                              decode and print orders + machine loads
  schedule <dir> --capacity '<json>'      print the production sequence
                                          ({"M1": 40} units/day; @file or @- for stdin)
  checkpoint <dir> <name>                 record a named checkpoint
  rollback <dir> <name>                   roll back to a named checkpoint
  verify <dir>                            incrementally decode and CRC-check all chunks

all output is JSON; errors print {"ok":false,"error":{...}} to stderr and exit
non-zero: E_USAGE=1 E_CRC=2 E_INDEX=3 E_CAPACITY=4 E_STATE=5 E_IO=6`;

function readJsonArg(flag, value) {
  if (value === undefined) {
    throw new PlanError('E_USAGE', `missing value for ${flag}`);
  }
  let text = value;
  if (value === '@-') {
    text = fs.readFileSync(0, 'utf8');
  } else if (value.startsWith('@')) {
    text = fs.readFileSync(value.slice(1), 'utf8');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new PlanError('E_USAGE', `${flag}: invalid JSON: ${err.message}`);
  }
}

function parseFlags(args, known) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!known.includes(name)) {
        throw new PlanError('E_USAGE', `unknown flag: ${arg}`);
      }
      i += 1;
      if (i >= args.length) {
        throw new PlanError('E_USAGE', `missing value for ${arg}`);
      }
      flags[name] = args[i];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 1) throw new PlanError('E_USAGE', 'init expects <dir>');
      Store.create(positional[0]);
      return { ok: true, store: positional[0] };
    }
    case 'add': {
      const { flags, positional } = parseFlags(rest, ['order']);
      if (positional.length !== 1) throw new PlanError('E_USAGE', 'add expects <dir>');
      const store = Store.open(positional[0]);
      const chunk = store.appendOrder(readJsonArg('--order', flags.order));
      return { ok: true, chunk, order: store.orders[store.orders.length - 1] };
    }
    case 'list': {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 1) throw new PlanError('E_USAGE', 'list expects <dir>');
      const store = Store.open(positional[0]);
      return {
        ok: true,
        orders: store.orders,
        loads: store.loads,
        chunks: store.manifest.chunks.length,
        checkpoints: Object.keys(store.manifest.checkpoints),
      };
    }
    case 'schedule': {
      const { flags, positional } = parseFlags(rest, ['capacity']);
      if (positional.length !== 1) throw new PlanError('E_USAGE', 'schedule expects <dir>');
      const store = Store.open(positional[0]);
      const plan = store.schedule(readJsonArg('--capacity', flags.capacity));
      return { ok: true, ...plan };
    }
    case 'checkpoint': {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 2) throw new PlanError('E_USAGE', 'checkpoint expects <dir> <name>');
      const store = Store.open(positional[0]);
      return { ok: true, checkpoint: store.checkpoint(positional[1]) };
    }
    case 'rollback': {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 2) throw new PlanError('E_USAGE', 'rollback expects <dir> <name>');
      const store = Store.open(positional[0]);
      return { ok: true, rolledBackTo: store.rollback(positional[1]) };
    }
    case 'verify': {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 1) throw new PlanError('E_USAGE', 'verify expects <dir>');
      const store = Store.open(positional[0]);
      return { ok: true, chunks: store.manifest.chunks.length, loads: store.loads };
    }
    case undefined:
    case 'help':
    case '--help':
      return { ok: true, usage: USAGE };
    default:
      throw new PlanError('E_USAGE', `unknown command: ${cmd}\n${USAGE}`);
  }
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const out = run(argv);
    io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } catch (err) {
    const code = err instanceof PlanError ? err.code : 'E_IO';
    const error = { code, message: err.message };
    for (const key of ['chunk', 'order', 'machine', 'finish', 'due']) {
      if (err[key] !== undefined) error[key] = err[key];
    }
    if (err.code === 'E_CRC' && err.state) {
      error.prefixChunks = err.chunk;
      error.prefixOrders = err.state.orders.map((o) => o.id);
    }
    io.stderr.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
    return EXIT_CODES[code] || EXIT_CODES.E_IO;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { run, main, USAGE };
