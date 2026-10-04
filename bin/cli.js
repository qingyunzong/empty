#!/usr/bin/env node
import fs from 'node:fs';
import { EventStore } from '../src/store.js';
import { FAULT_POINTS } from '../src/wal.js';
import { StoreError, ExitCode, exitCodeFor } from '../src/errors.js';

function parseArgs(argv) {
  const args = { command: argv[0], dir: process.env.WAL_DIR || './data', fault: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--dir') {
      args.dir = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--fault') {
      args.fault = argv[i + 1];
      i += 1;
    } else {
      throw new StoreError('E_ARGS', `unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function readJson(stdin, what) {
  if (stdin.length === 0) {
    throw new StoreError('E_ARGS', `${what}: missing JSON input on stdin`);
  }
  try {
    return JSON.parse(stdin);
  } catch {
    throw new StoreError('E_ARGS', `${what}: invalid JSON on stdin`);
  }
}

function emit(obj) {
  // Synchronous write: output must survive process.exit() (crash paths).
  fs.writeSync(1, `${JSON.stringify(obj)}\n`);
}

function fail(err) {
  const code = err instanceof StoreError ? err.code : 'E_IO';
  emit({ ok: false, error: code, message: err.message });
  process.exit(exitCodeFor(code));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stdin = await readStdin();

  switch (args.command) {
    case 'append': {
      const event = readJson(stdin, 'append');
      const store = new EventStore(args.dir).open();
      try {
        emit(store.append(event));
      } finally {
        store.close();
      }
      return;
    }
    case 'get': {
      const input = readJson(stdin, 'get');
      const store = new EventStore(args.dir).open();
      try {
        emit({ ok: true, event: store.get(input.eventId) });
      } finally {
        store.close();
      }
      return;
    }
    case 'query': {
      const input = readJson(stdin, 'query');
      const store = new EventStore(args.dir).open();
      try {
        const result = store.query(input);
        if (Array.isArray(result)) {
          emit({ ok: true, events: result });
        } else {
          emit({ ok: true, event: result });
        }
      } finally {
        store.close();
      }
      return;
    }
    case 'recover': {
      const store = new EventStore(args.dir).open();
      try {
        const stats = store.lastRecovery;
        emit({ ok: true, records: stats.records, truncatedBytes: stats.truncatedBytes });
      } finally {
        store.close();
      }
      return;
    }
    case 'crash': {
      const input = readJson(stdin, 'crash');
      const event = input.event !== undefined ? input.event : input;
      const fault = args.fault !== null ? args.fault : input.fault;
      if (!FAULT_POINTS.includes(fault)) {
        throw new StoreError('E_ARGS', `fault must be one of ${FAULT_POINTS.join('|')}`);
      }
      const store = new EventStore(args.dir).open();
      store.append(event, {
        fault,
        onFault: (point) => {
          emit({ ok: false, error: 'E_CRASH', fault: point });
          process.exit(ExitCode.E_CRASH);
        },
      });
      store.close();
      emit({ ok: true });
      return;
    }
    default:
      throw new StoreError('E_ARGS', `unknown command: ${args.command} (expected append|get|query|recover|crash)`);
  }
}

main().catch(fail);
