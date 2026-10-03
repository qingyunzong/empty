#!/usr/bin/env node
import { Store } from './store.js';
import { SchedError } from './rational.js';
import { pathToFileURL } from 'node:url';

const PATCH_FIELDS = ['release', 'deadline', 'duration', 'weight'];

function parseCommands(text) {
  const t = text.trim();
  if (!t) return [];
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [v];
  } catch {
    // Fall back to newline-delimited JSON.
    return t
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
}

function exec(store, cmd) {
  if (!cmd || typeof cmd !== 'object') {
    throw new SchedError('E_VALIDATION', 'command must be an object');
  }
  switch (cmd.op) {
    case 'add':
      return { ok: true, ...store.add(cmd.task ?? cmd) };
    case 'update': {
      const patch =
        cmd.patch ??
        Object.fromEntries(PATCH_FIELDS.filter((f) => f in cmd).map((f) => [f, cmd[f]]));
      return { ok: true, ...store.update(cmd.id, patch) };
    }
    case 'remove':
      return { ok: true, ...store.remove(cmd.id) };
    case 'undo':
      return { ok: true, ...store.undo() };
    case 'redo':
      return { ok: true, ...store.redo() };
    case 'solve':
      return { ok: true, ...store.solve() };
    case 'version':
      return { ok: true, version: store.version, versionCount: store.versionCount };
    default:
      throw new SchedError('E_UNKNOWN_OP', `unknown op: ${JSON.stringify(cmd.op)}`);
  }
}

// Runs a full command sequence (JSON array, single JSON object, or NDJSON)
// against a fresh store and returns the per-command result array.
export function runCommands(text) {
  const store = new Store();
  try {
    const commands = parseCommands(text);
    return commands.map((cmd) => {
      try {
        return exec(store, cmd);
      } catch (e) {
        return { ok: false, error: { code: e.code ?? 'E_INTERNAL', message: String(e.message) } };
      }
    });
  } catch (e) {
    return [{ ok: false, error: { code: 'E_PARSE', message: String(e.message) } }];
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const results = runCommands(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify(results) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
