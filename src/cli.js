// CLI implementation, exported for in-process testing.
// runCli(argv, io) returns the process exit code; io defaults to the
// real process streams.

import { readFileSync } from 'node:fs';
import { Ledger, LimitError, MAX_OPS } from './limit.js';
import { checkLinearizable } from './linearize.js';

const USAGE =
  'usage: limit run <ops.jsonl> [--explain] [--limit N]\n' +
  '       limit check <log.jsonl> [--limit N]';

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = { explain: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--explain') {
      flags.explain = true;
    } else if (arg === '--limit') {
      i += 1;
      if (i >= argv.length) throw new CliError('missing value for --limit', 2);
      const value = Number(argv[i]);
      if (!Number.isFinite(value) || value < 0) {
        throw new CliError('invalid --limit value: ' + argv[i], 2);
      }
      flags.limit = value;
    } else if (arg.startsWith('--')) {
      throw new CliError('unknown flag: ' + arg, 2);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError('cannot read ' + path + ': ' + err.message, 2);
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new CliError('line ' + (index + 1) + ': invalid JSON: ' + err.message, 2);
    }
  });
}

function cmdRun(file, flags, io) {
  const ops = readJsonl(file);
  if (ops.length > MAX_OPS) {
    throw new CliError('too many operations: ' + ops.length + ' (max ' + MAX_OPS + ')', 1);
  }
  const ledger = new Ledger(flags.limit);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      ledger.apply(op);
    } catch (err) {
      if (err instanceof LimitError) {
        if (flags.explain) {
          io.stdout(JSON.stringify({ line: i + 1, op, error: err.code }) + '\n');
        }
        throw new CliError('line ' + (i + 1) + ': ' + err.code + ': ' + err.message, 1);
      }
      throw err;
    }
    if (flags.explain) {
      io.stdout(JSON.stringify({ line: i + 1, op, ok: true, state: ledger.state() }) + '\n');
    }
  }
  io.stdout(JSON.stringify({ ok: true, ops: ops.length, state: ledger.state() }) + '\n');
  return 0;
}

function cmdCheck(file, flags, io) {
  const entries = readJsonl(file);
  if (entries.length > MAX_OPS) {
    throw new CliError('too many log entries: ' + entries.length + ' (max ' + MAX_OPS + ')', 1);
  }
  const outcome = checkLinearizable(entries, { defaultLimit: flags.limit });
  if (outcome.linearizable === true) {
    io.stdout('LINEARIZABLE\n');
    io.stdout('witness: ' + JSON.stringify(outcome.witness) + '\n');
    return 0;
  }
  if (outcome.linearizable === null) {
    io.stdout('UNKNOWN (' + outcome.reason + ')\n');
  } else {
    io.stdout('NOT_LINEARIZABLE\n');
  }
  return 1;
}

export function runCli(argv, io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}) {
  try {
    const { positional, flags } = parseArgs(argv);
    const [command, file] = positional;
    if ((command !== 'run' && command !== 'check') || !file) {
      throw new CliError(USAGE, 2);
    }
    return command === 'run' ? cmdRun(file, flags, io) : cmdCheck(file, flags, io);
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(err.message + '\n');
      return err.code;
    }
    throw err;
  }
}
