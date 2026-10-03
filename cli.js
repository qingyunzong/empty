#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replay, LedgerError } from './src/ledger.js';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  let file = null;
  let quota;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--quota') {
      const raw = argv[i + 1];
      i += 1;
      quota = Number(raw);
      if (raw === undefined || !Number.isFinite(quota) || quota < 0) {
        throw new CliError('USAGE', '--quota requires a non-negative number');
      }
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      return { help: true };
    } else if (file === null) {
      file = argv[i];
    } else {
      throw new CliError('USAGE', `unexpected argument: ${argv[i]}`);
    }
  }
  if (file === null) {
    throw new CliError('USAGE', 'missing history file. Usage: node cli.js <history.json> [--quota N]');
  }
  return { file, quota };
}

// Runs the CLI and returns the process exit code. All diagnostics are written
// through the injected streams so the function is testable in-process.
export async function runCli(argv, io = process) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n');
      return 1;
    }
    throw err;
  }
  if (parsed.help) {
    io.stdout.write('Usage: node cli.js <history.json> [--quota N]\n');
    return 0;
  }
  const { file, quota: quotaFlag } = parsed;

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    io.stderr.write(
      JSON.stringify({ error: { code: 'READ_ERROR', message: `cannot read ${file}: ${err.message}` } }) + '\n'
    );
    return 1;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    io.stderr.write(
      JSON.stringify({ error: { code: 'INVALID_JSON', message: `cannot parse ${file}: ${err.message}` } }) + '\n'
    );
    return 1;
  }

  let events;
  let quota = quotaFlag;
  if (Array.isArray(doc)) {
    events = doc;
  } else if (doc && typeof doc === 'object' && Array.isArray(doc.events)) {
    events = doc.events;
    if (quota === undefined) quota = doc.quota;
  } else {
    io.stderr.write(
      JSON.stringify({
        error: { code: 'INVALID_HISTORY', message: 'history file must be an event array or an object with an "events" array' },
      }) + '\n'
    );
    return 1;
  }
  if (quota === undefined) {
    io.stderr.write(
      JSON.stringify({
        error: { code: 'INVALID_HISTORY', message: 'quota is required (file field "quota" or --quota N)' },
      }) + '\n'
    );
    return 1;
  }

  try {
    const certificate = replay(events, quota);
    io.stdout.write(JSON.stringify(certificate, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      io.stderr.write(JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n');
      return 1;
    }
    throw err;
  }
}

const invokedAsMain =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
