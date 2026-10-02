import fs from 'node:fs';
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';
import { VM } from './vm.js';
import { Store } from './store.js';
import { JeError } from './errors.js';

const USAGE = `je - journal entry DSL compiler & ledger

usage:
  je run <batch.je> <events.json> --db <dir>   compile DSL, execute event batches
  je recover --db <dir>                        replay WAL, repair index, list IN_FLIGHT batches
  je balances --db <dir> [--period <p>]        print ledger balances from the index
  je batches --db <dir>                        print batch statuses
  je close-period <period> --db <dir>          close a period (further posting -> E_PERIOD)
`;

function parseArgs(argv) {
  const pos = [];
  let db = './je-db';
  let period;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') db = argv[++i];
    else if (argv[i] === '--period') period = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, db, period };
}

// Returns a process exit code. IO is injectable so tests can run in-process.
export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    return dispatch(argv, io);
  } catch (err) {
    if (err instanceof JeError) {
      io.err(`${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function dispatch(argv, io) {
  const [cmd, ...rest] = argv;
  const { pos, db, period } = parseArgs(rest);
  const printJson = (v) => io.out(JSON.stringify(v, null, 2) + '\n');

  if (cmd === 'run') {
    const [jeFile, eventsFile] = pos;
    if (!jeFile || !eventsFile) throw new JeError('E_USAGE', 'je run <batch.je> <events.json> --db <dir>');
    const program = compile(check(parse(fs.readFileSync(jeFile, 'utf8'))));
    const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    const store = new Store(db);
    const vm = new VM(program, store);
    for (const batch of events.batches || []) {
      vm.runBatch(batch.id, batch.period, batch.events || []);
      io.out(`batch ${batch.id} committed (${(batch.events || []).length} event(s), period ${batch.period})\n`);
    }
    io.out('balances:\n');
    printJson(store.balances());
    return 0;
  }

  if (cmd === 'recover') {
    const store = new Store(db);
    const result = store.recover();
    io.out(`recovery complete: replayed ${result.replayed} action(s)\n`);
    if (result.inFlight.length > 0) {
      io.out(`IN_FLIGHT batches (pending, NOT failed): ${result.inFlight.join(', ')}\n`);
    } else {
      io.out('no in-flight batches\n');
    }
    return 0;
  }

  if (cmd === 'balances') {
    printJson(new Store(db).balances(period));
    return 0;
  }

  if (cmd === 'batches') {
    printJson(new Store(db).batchStatus());
    return 0;
  }

  if (cmd === 'close-period') {
    const [p] = pos;
    if (!p) throw new JeError('E_USAGE', 'je close-period <period> --db <dir>');
    new Store(db).closePeriod(p);
    io.out(`period ${p} closed\n`);
    return 0;
  }

  io.out(USAGE);
  return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
}
