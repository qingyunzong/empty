#!/usr/bin/env node
/**
 * Offline JSON CLI for the MVCC event store.
 *
 * Input:  a JSON command object, or an array of command objects, read from a file
 *         argument or from stdin:
 *           node src/cli.js commands.json
 *           echo '[{"op":"create",...}]' | node src/cli.js
 *
 * Commands:
 *   {"op":"create",   "eventId":"A","deviceId":"d1","validAt":"2026-01-01T00:00:00Z","data":{...}}
 *   {"op":"correct",  "eventId":"A","validAt":...,"data":{...}}        // omitted fields inherit
 *   {"op":"delete",   "eventId":"A"}
 *   {"op":"snapshot"}                                                   // -> {"snapshot":"snap-1","txAt":N}
 *   {"op":"get",      "eventId":"A","snapshot":"snap-1"?}               // default: latest
 *   {"op":"range",    "deviceId":"d1","from":...,"to":...,"snapshot":"snap-1"?}
 *
 * validAt/from/to accept epoch-ms numbers or ISO-8601 strings; from/to may be
 * omitted for an open bound.
 *
 * Output: JSON on stdout. One result per command:
 *   {"ok":true,"result":...} or {"ok":false,"error":{"code":"E_DUP","message":"..."}}
 *
 * Exit codes:
 *   0  every command succeeded
 *   1  at least one command failed with a store error (E_DUP / E_NOTFOUND / E_INVALID)
 *   2  usage error (unreadable input, invalid JSON, unknown op, unknown snapshot)
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EventStore, StoreError } from './store.js';

class UsageError extends Error {}

const USAGE = `usage: node src/cli.js [commands.json|-]
  Reads a JSON command object or array of commands from the file argument
  (or stdin), executes them against one in-memory store, prints JSON results.
  exit codes: 0 ok, 1 store error (E_DUP/E_NOTFOUND/E_INVALID), 2 usage error.`;

function usageFailure(message) {
  return { code: 2, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: 'E_USAGE', message } })}\n` };
}

/** Execute a JSON script (string) against a fresh store. Pure: no process I/O. */
export function runCli(raw) {
  let script;
  try {
    script = JSON.parse(raw);
  } catch (err) {
    return usageFailure(`invalid JSON: ${err.message}`);
  }

  const single = !Array.isArray(script);
  const commands = single ? [script] : script;

  const store = new EventStore();
  const snapshots = new Map();
  let snapSeq = 0;
  let exitCode = 0;
  const results = [];

  const resolveSnapshot = (cmd) => {
    if (cmd.snapshot === undefined || cmd.snapshot === null) return store.snapshot();
    const snap = snapshots.get(cmd.snapshot);
    if (!snap) throw new UsageError(`unknown snapshot: ${cmd.snapshot}`);
    return snap;
  };

  const run = (cmd) => {
    if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
      throw new UsageError('each command must be a JSON object');
    }
    switch (cmd.op) {
      case 'create':
        return store.create(cmd);
      case 'correct':
        return store.correct(cmd);
      case 'delete':
        return store.delete(cmd.eventId);
      case 'snapshot': {
        const id = `snap-${++snapSeq}`;
        const snap = store.snapshot();
        snapshots.set(id, snap);
        return { snapshot: id, txAt: snap.ts };
      }
      case 'get':
        return resolveSnapshot(cmd).get(cmd.eventId);
      case 'range':
        return resolveSnapshot(cmd).range(cmd.deviceId, cmd.from, cmd.to);
      default:
        throw new UsageError(`unknown op: ${JSON.stringify(cmd.op)}`);
    }
  };

  for (const cmd of commands) {
    try {
      results.push({ ok: true, result: run(cmd) });
    } catch (err) {
      if (err instanceof UsageError) return usageFailure(err.message);
      if (err instanceof StoreError) {
        exitCode = 1;
        results.push({ ok: false, error: { code: err.code, message: err.message } });
      } else {
        throw err;
      }
    }
  }

  return { code: exitCode, stdout: `${JSON.stringify(single ? results[0] : results, null, 2)}\n`, stderr: '' };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (args.length > 1) {
    const out = usageFailure('expected at most one file argument');
    process.stderr.write(out.stderr);
    process.exit(out.code);
  }

  let raw;
  try {
    raw = args.length === 1 && args[0] !== '-' ? readFileSync(args[0], 'utf8') : await readStdin();
  } catch (err) {
    const out = usageFailure(`cannot read input: ${err.message}`);
    process.stderr.write(out.stderr);
    process.exit(out.code);
  }

  const out = runCli(raw);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.code);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: String(err && err.message) } })}\n`);
    process.exit(2);
  });
}
