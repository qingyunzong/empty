import { parseArgs } from 'node:util';
import { MVCCStore, MvccError } from './mvcc.js';

export const EXIT_CODES = {
  CONFLICT: 2,
  NO_TAG: 3,
  GC_REFUSED: 4,
};

const USAGE = `Usage: mvcc <command> [options]

Commands:
  commit   --db DIR [--set key=value]... [--delete key]... [key=value ...]
  read     --db DIR [--tag NAME] [key]        dump one value or all key=value pairs
  snapshot --db DIR NAME                      tag the current sequence as NAME
  gc       --db DIR [--before SEQ]            collect unreferenced old versions

Exit codes: 0 ok, 1 usage/error, 2 CONFLICT, 3 NO_TAG, 4 GC_REFUSED`;

class UsageError extends Error {}

function parseSetPair(pair) {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new UsageError(`invalid --set pair (expected key=value): ${pair}`);
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

function cmdCommit(args, io) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      set: { type: 'string', multiple: true, default: [] },
      delete: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.db) throw new UsageError('commit requires --db DIR');
  const store = MVCCStore.open(values.db);
  try {
    const tx = store.beginWrite();
    for (const pair of [...values.set, ...positionals]) {
      const [key, value] = parseSetPair(pair);
      tx.set(key, value);
    }
    for (const key of values.delete) tx.delete(key);
    const seq = tx.commit();
    io.stdout(`committed seq=${seq}\n`);
  } finally {
    store.close();
  }
}

function cmdRead(args, io) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      tag: { type: 'string' },
    },
  });
  if (!values.db) throw new UsageError('read requires --db DIR');
  const store = MVCCStore.open(values.db);
  try {
    const tx = store.beginRead(values.tag !== undefined ? { tag: values.tag } : {});
    try {
      if (positionals.length > 0) {
        const value = tx.get(positionals[0]);
        if (value === null) return 1;
        io.stdout(value);
        io.stdout('\n');
      } else {
        for (const [key, value] of tx.entries()) {
          io.stdout(`${key}=${value.toString('utf8')}\n`);
        }
      }
    } finally {
      tx.close();
    }
  } finally {
    store.close();
  }
  return 0;
}

function cmdSnapshot(args, io) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { db: { type: 'string' } },
  });
  if (!values.db) throw new UsageError('snapshot requires --db DIR');
  const name = positionals[0];
  if (!name) throw new UsageError('snapshot requires a tag name');
  const store = MVCCStore.open(values.db);
  try {
    const seq = store.snapshot(name);
    io.stdout(`snapshot ${name} seq=${seq}\n`);
  } finally {
    store.close();
  }
}

function cmdGc(args, io) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      before: { type: 'string' },
    },
  });
  if (!values.db) throw new UsageError('gc requires --db DIR');
  const store = MVCCStore.open(values.db);
  try {
    const before = values.before !== undefined ? Number(values.before) : undefined;
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) {
      throw new UsageError(`invalid --before value: ${values.before}`);
    }
    const collected = store.gc(before);
    io.stdout(`gc collected ${collected} version(s)\n`);
  } finally {
    store.close();
  }
}

const COMMANDS = {
  commit: cmdCommit,
  read: cmdRead,
  snapshot: cmdSnapshot,
  gc: cmdGc,
};

// Runs the CLI. argv excludes node/script. io provides stdout/stderr sinks
// (strings or Buffers). Returns the process exit code.
export function runCli(argv, io) {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === '-h') {
      io.stdout(USAGE + '\n');
      return command ? 0 : 1;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`unknown command: ${command}`);
    return handler(rest, io) ?? 0;
  } catch (err) {
    if (err instanceof MvccError) {
      io.stderr(`${err.code}: ${err.message}\n`);
      return EXIT_CODES[err.code] ?? 1;
    }
    if (err instanceof UsageError) {
      io.stderr(`ERROR: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
