import fs from 'node:fs';
import { Ledger, LedgerError } from './ledger.js';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dir' || arg === '--as-of') {
      if (i + 1 >= args.length) throw new CliError('E_ARGS', `missing value for ${arg}`);
      flags[arg] = args[i + 1];
      i += 1;
    } else if (arg === '--no-negative') {
      flags['--no-negative'] = true;
    } else if (arg.startsWith('--dir=')) {
      flags['--dir'] = arg.slice('--dir='.length);
    } else if (arg.startsWith('--as-of=')) {
      flags['--as-of'] = arg.slice('--as-of='.length);
    } else if (arg.startsWith('-')) {
      throw new CliError('E_ARGS', `unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function openLedger(flags) {
  const dir = flags['--dir'] ?? process.env.LEDGER_DIR ?? './ledger-data';
  const allowNegative = !flags['--no-negative'];
  return Ledger.open(dir, { allowNegative });
}

function applyOp(ledger, op) {
  switch (op.op) {
    case 'post':
      return ledger.post(op.id, op.account, op.amount, op.meta ?? null);
    case 'reverse':
      return ledger.reverse(op.id, op.reason ?? null);
    case 'settle':
      return ledger.settle(op.upTo);
    default:
      throw new LedgerError('E_ARGS', `unknown op "${op.op}"`);
  }
}

function cmdApply(positional, flags, stdout) {
  const file = positional[0];
  if (!file) throw new CliError('E_ARGS', 'usage: ledger apply <file.jsonl> [--dir D] [--no-negative]');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError('E_IO', `cannot read ${file}: ${err.message}`);
  }
  const ledger = openLedger(flags);
  try {
    const lines = content.split('\n');
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n].trim();
      if (line === '') continue;
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        throw new CliError('E_ARGS', `line ${n + 1}: invalid JSON`);
      }
      const result = applyOp(ledger, op);
      stdout(`${JSON.stringify({ line: n + 1, ...result })}\n`);
    }
  } finally {
    ledger.close();
  }
}

function cmdBalance(positional, flags, stdout) {
  const account = positional[0];
  if (!account) throw new CliError('E_ARGS', 'usage: ledger balance <account> [--as-of N] [--dir D]');
  let asOf;
  if (flags['--as-of'] !== undefined) {
    asOf = Number(flags['--as-of']);
    if (!Number.isInteger(asOf) || asOf < 0) {
      throw new CliError('E_ARGS', '--as-of must be a non-negative integer');
    }
  }
  const ledger = openLedger(flags);
  try {
    const value = ledger.balance(account, asOf);
    stdout(`${JSON.stringify({ account, asOf: asOf ?? null, balance: value })}\n`);
  } finally {
    ledger.close();
  }
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  try {
    const [command, ...rest] = argv;
    const { positional, flags } = parseFlags(rest);
    switch (command) {
      case 'apply':
        cmdApply(positional, flags, stdout);
        break;
      case 'balance':
        cmdBalance(positional, flags, stdout);
        break;
      default:
        throw new CliError('E_ARGS', 'usage: ledger <apply|balance> ...');
    }
    return 0;
  } catch (err) {
    const code = err instanceof LedgerError || err instanceof CliError ? err.code : 'E_IO';
    const message = err?.message ?? String(err);
    stderr(`${JSON.stringify({ code, message })}\n`);
    return 1;
  }
}
