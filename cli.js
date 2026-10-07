#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store, StoreError } from './src/store.js';
import { canonical } from './src/canonical.js';

const USAGE = 'usage: node cli.js [--data-dir DIR]  # reads JSON commands on stdin';

function usageError(message) {
  return { status: 2, stdout: '', stderr: canonical({ code: 'E_USAGE', message }) + '\n' };
}

function parseArgs(argv, env) {
  let dataDir = env.SCHED_DATA_DIR || './sched-data';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') {
      if (i + 1 >= argv.length) return { error: '--data-dir requires a value. ' + USAGE };
      dataDir = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      return { help: true };
    } else {
      return { error: `unknown argument: ${argv[i]}. ` + USAGE };
    }
  }
  return { dataDir };
}

function parseCommands(text) {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'no commands on stdin. ' + USAGE };
  try {
    const parsed = JSON.parse(trimmed);
    return { commands: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    // Fall back to newline-delimited JSON.
    const commands = [];
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        commands.push(JSON.parse(line));
      } catch {
        return { error: `invalid JSON on line ${i + 1}` };
      }
    }
    return { commands };
  }
}

function runCommand(store, cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.op !== 'string') {
    throw new StoreError('E_USAGE', 'each command must be an object with a string "op"');
  }
  const needTx = () => {
    if (typeof cmd.tx !== 'string') throw new StoreError('E_USAGE', `${cmd.op} requires string field "tx"`);
  };
  const needKey = () => {
    if (typeof cmd.key !== 'string') throw new StoreError('E_USAGE', `${cmd.op} requires string field "key"`);
  };
  switch (cmd.op) {
    case 'begin': {
      const tx = store.begin();
      return { ok: true, tx, baseVersion: store.baseVersionOf(tx) };
    }
    case 'get':
      needTx();
      needKey();
      return { ok: true, value: store.get(cmd.tx, cmd.key) };
    case 'put':
      needTx();
      needKey();
      if (!Object.hasOwn(cmd, 'value')) throw new StoreError('E_USAGE', 'put requires field "value"');
      store.put(cmd.tx, cmd.key, cmd.value);
      return { ok: true };
    case 'commit':
      needTx();
      return { ok: true, version: store.commit(cmd.tx) };
    case 'abort':
      needTx();
      store.abort(cmd.tx);
      return { ok: true };
    default:
      throw new StoreError('E_USAGE', `unknown op: ${cmd.op}`);
  }
}

// Pure entry point: argv (without node/script), stdin text, env.
// Returns { status, stdout, stderr } without touching the process.
export function runCli(argv, stdinText, env = {}) {
  const args = parseArgs(argv, env);
  if (args.help) return { status: 0, stdout: USAGE + '\n', stderr: '' };
  if (args.error) return usageError(args.error);

  const parsed = parseCommands(stdinText);
  if (parsed.error) return usageError(parsed.error);

  const store = Store.open(args.dataDir);
  let firstError = null;
  let hasUsage = false;
  const out = [];
  for (const cmd of parsed.commands) {
    let result;
    try {
      result = runCommand(store, cmd);
    } catch (err) {
      const code = err instanceof StoreError ? err.code : 'E_INTERNAL';
      result = { ok: false, code, message: String((err && err.message) || err) };
      if (!firstError) firstError = result;
      if (code === 'E_USAGE') hasUsage = true;
    }
    out.push(canonical(result));
  }
  const stdout = out.join('\n') + '\n';
  if (firstError) {
    const stderr = canonical({ code: firstError.code, message: firstError.message }) + '\n';
    return { status: hasUsage ? 2 : 1, stdout, stderr };
  }
  return { status: 0, stdout, stderr: '' };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const result = runCli(process.argv.slice(2), fs.readFileSync(0, 'utf8'), process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status);
}
