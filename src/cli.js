#!/usr/bin/env node
// Offline single-machine CLI for the WAL event store.
// Input: JSON via --input '<json>', --input @file, or stdin.
// Output: single-line JSON on stdout. Exit codes:
//   0  success
//   1  E_INTERNAL (unexpected error)
//   2  E_DUP (duplicate eventId)
//   3  E_NOTFOUND
//   4  E_USAGE (bad command line / missing input)
//   5  E_VALIDATION (invalid event or query)
//   6  E_IO
//   7  E_CORRUPT
//   70 simulated crash (command "crash")
import fs from 'node:fs';
import { EventStore, StoreError, CRASH_POINTS } from './store.js';

const EXIT_CODES = {
  E_INTERNAL: 1,
  E_DUP: 2,
  E_NOTFOUND: 3,
  E_USAGE: 4,
  E_VALIDATION: 5,
  E_IO: 6,
  E_CORRUPT: 7,
};
const CRASH_EXIT = 70;

function out(obj) {
  fs.writeSync(1, `${JSON.stringify(obj)}\n`);
}

function fail(code, message) {
  out({ ok: false, error: code, message });
  process.exit(EXIT_CODES[code] ?? EXIT_CODES.E_INTERNAL);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        opts[arg.slice(2)] = argv[i + 1];
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

async function readStdin() {
  // Async read: fd 0 may be a non-blocking pipe (e.g. spawned by a Node
  // parent), where a synchronous read would spin on EAGAIN forever.
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readInput(opts) {
  if (opts.input !== undefined) {
    return opts.input.startsWith('@') ? fs.readFileSync(opts.input.slice(1), 'utf8') : opts.input;
  }
  return readStdin();
}

async function readJsonInput(opts, { required }) {
  const raw = (await readInput(opts)).trim();
  if (raw.length === 0) {
    if (required) fail('E_USAGE', 'missing JSON input (stdin or --input)');
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('E_USAGE', 'input is not valid JSON');
  }
  return undefined;
}

function requireWal(opts) {
  if (typeof opts.wal !== 'string' || opts.wal.length === 0) {
    fail('E_USAGE', 'missing required --wal <path>');
  }
  return opts.wal;
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command) {
    fail('E_USAGE', 'usage: cli.js <append|get|query|recover|crash> --wal <path> [--input <json>|--input @file|--at <point>]');
  }

  if (command === 'append') {
    const event = await readJsonInput(opts, { required: true });
    const store = EventStore.open(requireWal(opts));
    try {
      const { walSeq } = store.append(event);
      out({ ok: true, walSeq, eventId: event.eventId });
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'crash') {
    const at = opts.at;
    if (!CRASH_POINTS.includes(at)) {
      fail('E_USAGE', `--at must be one of: ${CRASH_POINTS.join(', ')}`);
    }
    const event = await readJsonInput(opts, { required: true });
    const store = EventStore.open(requireWal(opts));
    // Announce the crash synchronously, then die mid-append at the fault point.
    out({ ok: false, crashed: true, at });
    store.append(event, { crashAt: at, onCrash: () => process.exit(CRASH_EXIT) });
    return; // unreachable when crashAt matches
  }

  if (command === 'get') {
    const input = await readJsonInput(opts, { required: true });
    if (typeof input.eventId !== 'string') fail('E_USAGE', 'input must contain "eventId"');
    const store = EventStore.open(requireWal(opts));
    try {
      const event = store.get(input.eventId);
      if (event === null) fail('E_NOTFOUND', `eventId not found: ${input.eventId}`);
      out({ ok: true, event });
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'query') {
    const input = await readJsonInput(opts, { required: true });
    if (typeof input.deviceId !== 'string') fail('E_USAGE', 'input must contain "deviceId"');
    const store = EventStore.open(requireWal(opts));
    try {
      const events = store.query(input.deviceId, input.seq);
      out({ ok: true, events });
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'recover') {
    const store = EventStore.open(requireWal(opts));
    try {
      const stats = store.recover();
      out({ ok: true, ...stats });
    } finally {
      store.close();
    }
    return;
  }

  fail('E_USAGE', `unknown command: ${command}`);
}

try {
  await main();
} catch (err) {
  if (err instanceof StoreError) {
    fail(err.code, err.message);
  }
  if (err && err.code && String(err.code).startsWith('E')) {
    fail('E_IO', err.message);
  }
  fail('E_INTERNAL', err && err.message ? err.message : String(err));
}
