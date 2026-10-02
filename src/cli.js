import { readFileSync } from 'node:fs';
import { Ledger } from './ledger.js';
import { CardError, E } from './errors.js';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  if (command !== 'apply' || !file) {
    throw new CliError(E.USAGE, 'usage: card apply <events.jsonl> [--stats <merchant> <day>]');
  }
  let stats = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--stats') {
      const merchant = rest[i + 1];
      const day = rest[i + 2];
      if (!merchant || !day) throw new CliError(E.USAGE, '--stats requires <merchant> <day>');
      stats = { merchant, day };
      i += 2;
    } else {
      throw new CliError(E.USAGE, `unknown argument ${JSON.stringify(rest[i])}`);
    }
  }
  return { file, stats };
}

// Runs the CLI. Returns the exit code; writes JSON lines via io.stdout/io.stderr.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    const { file, stats } = parseArgs(argv);

    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliError(E.IO, `cannot read ${file}: ${err.message}`);
    }

    const ledger = new Ledger();
    const lines = content.split('\n');
    let applied = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        throw new CliError(E.VALIDATION, `line ${i + 1}: invalid JSON: ${err.message}`);
      }
      try {
        ledger.apply(event);
      } catch (err) {
        if (err instanceof CardError) {
          throw new CliError(err.code, `line ${i + 1}: ${err.message}`);
        }
        throw err;
      }
      applied += 1;
    }

    const out = stats
      ? ledger.merchantStats(stats.merchant, stats.day)
      : { applied };
    io.stdout(JSON.stringify(out) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(JSON.stringify({ code: err.code, message: err.message }) + '\n');
      return 1;
    }
    throw err;
  }
}
