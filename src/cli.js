import path from 'node:path';
import { Store } from './store.js';
import { QcError, E } from './errors.js';

export const EXIT = Object.freeze({
  ok: 0,
  generic: 1,
  usage: 2,
  [E.CRC]: 3,
  [E.REFERENCE]: 4,
});

const USAGE = `qc - offline inspection record store

usage: qc [--root DIR] <command> [options]

commands:
  init <batch> --baseline N --min N --max N [--unit U] [--at T] [--chunk-size N]
  measure <batch> --value N [--at T]
  correct <batch> --refs SEQ --value N --reason TEXT [--at T]
  show <batch> [--as-of SEQ]
  find <batch> --at T
  list
  scan

options:
  --root DIR   store root (default: $QC_ROOT or ./qc-data)
  T            ISO-8601 time or epoch milliseconds
exit codes: 0 ok, 1 error, 2 usage, 3 E_CRC, 4 E_REFERENCE
`;

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 >= argv.length) throw new QcError(E.INVALID, `missing value for --${key}`);
      opts[key] = argv[i + 1];
      i += 1;
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

function num(opts, key, { required = true } = {}) {
  const raw = opts[key];
  if (raw === undefined) {
    if (required) throw new QcError(E.INVALID, `missing --${key}`);
    return undefined;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new QcError(E.INVALID, `--${key} must be a number`);
  return v;
}

function parseAt(raw) {
  if (raw === undefined) return undefined;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

// Runs one CLI invocation. Returns the process exit code; output goes to the
// injected io streams so the same code path is testable in-process.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    return main(argv, io);
  } catch (err) {
    if (err instanceof QcError) {
      io.stderr(`error: ${err.code}: ${err.message}\n`);
      return EXIT[err.code] ?? EXIT.generic;
    }
    io.stderr(`error: ${err.message}\n`);
    return EXIT.generic;
  }
}

function main(argv, io) {
  const { opts, pos } = parseArgs(argv);
  const root = opts.root || process.env.QC_ROOT || path.join(process.cwd(), 'qc-data');
  const [cmd, batchId] = pos;
  const store = new Store(root);
  const print = (value) => io.stdout(JSON.stringify(value, null, 2) + '\n');

  switch (cmd) {
    case 'init': {
      if (!batchId) throw new QcError(E.INVALID, 'missing batch id');
      print(store.initBatch({
        batchId,
        baseline: num(opts, 'baseline'),
        min: num(opts, 'min'),
        max: num(opts, 'max'),
        unit: opts.unit || '',
        at: parseAt(opts.at),
        chunkSize: opts['chunk-size'] !== undefined ? num(opts, 'chunk-size') : 16,
      }));
      return EXIT.ok;
    }
    case 'measure': {
      if (!batchId) throw new QcError(E.INVALID, 'missing batch id');
      print(store.appendMeasure(batchId, { value: num(opts, 'value'), at: parseAt(opts.at) }));
      return EXIT.ok;
    }
    case 'correct': {
      if (!batchId) throw new QcError(E.INVALID, 'missing batch id');
      print(store.appendCompensation(batchId, {
        refs: num(opts, 'refs'),
        value: num(opts, 'value'),
        reason: opts.reason,
        at: parseAt(opts.at),
      }));
      return EXIT.ok;
    }
    case 'show': {
      if (!batchId) throw new QcError(E.INVALID, 'missing batch id');
      const asOfSeq = opts['as-of'] !== undefined ? num(opts, 'as-of') : undefined;
      print(store.decode(batchId, { asOfSeq }));
      return EXIT.ok;
    }
    case 'find': {
      if (!batchId) throw new QcError(E.INVALID, 'missing batch id');
      if (opts.at === undefined) throw new QcError(E.INVALID, 'missing --at');
      print(store.findAt(batchId, parseAt(opts.at)));
      return EXIT.ok;
    }
    case 'list': {
      print(store.listBatches());
      return EXIT.ok;
    }
    case 'scan': {
      print(store.scan());
      return EXIT.ok;
    }
    default:
      io.stderr(USAGE);
      return EXIT.usage;
  }
}
