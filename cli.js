#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { SchemaError } from './src/schema.js';
import {
  DEFAULT_STATE_PATH,
  loadStore,
  saveStore,
  ingestEvents,
  queryStore,
  diffStore,
} from './src/store.js';

const USAGE = `Usage: node cli.js <command> [options]

Commands:
  ingest   Ingest events (JSON array or NDJSON) from --file or stdin
  query    Compute per-device downtime intervals, duration and availability
  diff     Show versioned corrections between two store versions

Options:
  --state <path>      State file (default: ${DEFAULT_STATE_PATH})
  --file <path>       Input events file for ingest (default: stdin)
  --watermark <ms>    Watermark timestamp; open intervals end here when passed
  --device <name>     Restrict query to a single device
  --from <n>          diff: start version (default: to - 1)
  --to <n>            diff: end version (default: current version)

Exit codes: 0 success, 1 schema validation error, 2 other failure.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`missing value for --${key}`);
      }
      args[key] = value;
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function parseNumberOption(value, name) {
  if (value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new UsageError(`--${name} must be a finite number, got "${value}"`);
  return num;
}

function parseVersionOption(value, name) {
  if (value === undefined) return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return num;
}

function parseEventsPayload(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to NDJSON: one JSON event per line.
    return trimmed.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  }
}

function readInput(file) {
  if (file !== undefined) return readFileSync(file, 'utf8');
  return readFileSync(0, 'utf8'); // stdin
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const statePath = args.state ?? DEFAULT_STATE_PATH;

  switch (command) {
    case 'ingest': {
      const events = parseEventsPayload(readInput(args.file));
      const store = loadStore(statePath);
      const result = ingestEvents(store, events);
      saveStore(store, statePath);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return 0;
    }
    case 'query': {
      const store = loadStore(statePath);
      const result = queryStore(store, {
        watermark: parseNumberOption(args.watermark, 'watermark'),
        device: args.device ?? null,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case 'diff': {
      const store = loadStore(statePath);
      const result = diffStore(store, {
        from: parseVersionOption(args.from, 'from'),
        to: parseVersionOption(args.to, 'to'),
        watermark: parseNumberOption(args.watermark, 'watermark'),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof SchemaError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(2);
}
