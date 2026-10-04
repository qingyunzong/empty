#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store, StoreError } from './store.js';
import { stringify } from './canonical.js';

const CONFLICT_CODES = new Set(['E_UNIQUE', 'E_SNAPSHOT']);

const USAGE = [
  'Usage: cli.js [--data <dir>]',
  '',
  'Reads a JSON array of commands (or newline-delimited JSON commands) from stdin,',
  'writes one canonical JSON result per command to stdout.',
  '',
  'Commands:',
  '  {"op":"begin","tx":"t1"}',
  '  {"op":"get","tx":"t1","key":"wo-1"}',
  '  {"op":"put","tx":"t1","key":"wo-1","value":{"workcenter":"w1","timeSlot":"t1"}}',
  '  {"op":"commit","tx":"t1"}',
  '  {"op":"abort","tx":"t1"}',
  '',
  'Exit codes: 0 success, 1 unique/snapshot conflict, 2 usage error.',
  'On failure stderr carries a canonical JSON {"code","message"} object.',
].join('\n');

function parseInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to newline-delimited JSON.
    return trimmed
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
}

// Executes commands against `store`; returns { results, exitCode, firstError }.
export function execute(commands, store) {
  const txs = new Map();
  const results = [];
  let exitCode = 0;
  let firstError = null;

  const recordError = (code, message, fatal) => {
    results.push({ ok: false, code, message });
    if (!firstError) firstError = { code, message };
    if (fatal) exitCode = 2;
    else if (exitCode === 0) exitCode = 1;
  };

  const requireTx = (cmd) => {
    if (typeof cmd.tx !== 'string') {
      throw new StoreError('E_USAGE', `command ${stringify(cmd)} requires a string "tx"`);
    }
    const tx = txs.get(cmd.tx);
    if (!tx || !tx.active) {
      throw new StoreError('E_USAGE', `unknown or inactive transaction ${JSON.stringify(cmd.tx)}`);
    }
    return tx;
  };

  for (const cmd of commands) {
    if (exitCode === 2) break; // usage errors abort the script
    try {
      if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.op !== 'string') {
        throw new StoreError('E_USAGE', 'each command must be an object with a string "op"');
      }
      switch (cmd.op) {
        case 'begin': {
          if (typeof cmd.tx !== 'string') {
            throw new StoreError('E_USAGE', 'begin requires a string "tx"');
          }
          if (txs.has(cmd.tx) && txs.get(cmd.tx).active) {
            throw new StoreError('E_USAGE', `transaction ${JSON.stringify(cmd.tx)} already active`);
          }
          const tx = store.begin();
          txs.set(cmd.tx, tx);
          results.push({ ok: true, tx: cmd.tx, snapshot: tx.snapshot });
          break;
        }
        case 'get': {
          const tx = requireTx(cmd);
          if (typeof cmd.key !== 'string') {
            throw new StoreError('E_USAGE', 'get requires a string "key"');
          }
          const value = tx.get(cmd.key);
          results.push({ ok: true, found: value !== undefined, value: value === undefined ? null : value });
          break;
        }
        case 'put': {
          const tx = requireTx(cmd);
          if (typeof cmd.key !== 'string') {
            throw new StoreError('E_USAGE', 'put requires a string "key"');
          }
          if (!Object.hasOwn(cmd, 'value')) {
            throw new StoreError('E_USAGE', 'put requires a "value" field (use null to delete)');
          }
          tx.put(cmd.key, cmd.value);
          results.push({ ok: true });
          break;
        }
        case 'commit': {
          const tx = requireTx(cmd);
          const version = tx.commit();
          results.push({ ok: true, version });
          break;
        }
        case 'abort': {
          const tx = requireTx(cmd);
          tx.abort();
          results.push({ ok: true });
          break;
        }
        default:
          throw new StoreError('E_USAGE', `unknown op ${JSON.stringify(cmd.op)}`);
      }
    } catch (err) {
      if (err instanceof StoreError && CONFLICT_CODES.has(err.code)) {
        recordError(err.code, err.message, false);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        recordError('E_USAGE', message, true);
      }
    }
  }
  return { results, exitCode, firstError };
}

export function runCli(argv, input) {
  let dir = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data' || arg === '-d') {
      dir = argv[i + 1];
      i += 1;
      if (dir === undefined) {
        return { code: 2, stdout: '', stderr: stringify({ code: 'E_USAGE', message: '--data requires a directory argument' }) + '\n' };
      }
    } else if (arg === '--help' || arg === '-h') {
      return { code: 0, stdout: USAGE + '\n', stderr: '' };
    } else {
      return { code: 2, stdout: '', stderr: stringify({ code: 'E_USAGE', message: `unknown argument ${JSON.stringify(arg)}` }) + '\n' };
    }
  }

  let commands;
  try {
    commands = parseInput(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 2, stdout: '', stderr: stringify({ code: 'E_USAGE', message: `invalid JSON input: ${message}` }) + '\n' };
  }

  const store = dir ? Store.open(dir) : new Store();
  const { results, exitCode, firstError } = execute(commands, store);
  const stdout = results.map((r) => stringify(r) + '\n').join('');
  const stderr = firstError ? stringify(firstError) + '\n' : '';
  return { code: exitCode, stdout, stderr };
}

const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const { code, stdout, stderr } = runCli(process.argv.slice(2), input);
    // Synchronous writes so nothing is lost when the process exits.
    if (stdout) fs.writeSync(1, stdout);
    if (stderr) fs.writeSync(2, stderr);
    process.exitCode = code;
  });
}
