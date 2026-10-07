#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { Ledger } from './engine.js';

export function parseArgs(argv) {
  let statePath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--state') {
      i += 1;
      if (i >= argv.length) throw new Error('--state requires a path');
      statePath = argv[i];
    } else if (arg.startsWith('--state=')) {
      statePath = arg.slice('--state='.length);
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, statePath: null };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, statePath };
}

export function execute(input, argv = []) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return { code: 1, stdout: '', stderr: JSON.stringify({ ok: false, error: error.message }) + '\n' };
  }
  if (args.help) {
    return {
      code: 0,
      stdout: 'Usage: node src/cli.js [--state <path>]\n'
        + 'Reads a JSON array of ops (or {"ops":[...]}) from stdin, writes JSON to stdout.\n',
      stderr: '',
    };
  }

  const fail = (message) => ({ code: 1, stdout: '', stderr: JSON.stringify({ ok: false, error: message }) + '\n' });

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return fail('stdin is not valid JSON');
  }

  const ops = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.ops) ? parsed.ops : null);
  if (ops === null) return fail('expected a JSON array of ops or an object with an "ops" array');

  let prior = [];
  if (args.statePath !== null && existsSync(args.statePath)) {
    try {
      const saved = JSON.parse(readFileSync(args.statePath, 'utf8'));
      if (!saved || !Array.isArray(saved.submitted)) throw new Error('bad shape');
      prior = saved.submitted;
    } catch {
      return fail(`state file is corrupt: ${args.statePath}`);
    }
  }

  const ledger = new Ledger();
  let results;
  try {
    ledger.submitAll(prior);
    results = ledger.submitAll(ops);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (args.statePath !== null) {
    const tmp = `${args.statePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify({ submitted: [...prior, ...ops] }, null, 2) + '\n');
      renameSync(tmp, args.statePath);
    } catch (error) {
      return fail(`failed to persist state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const out = {
    ok: true,
    view: ledger.view,
    results,
    log: ledger.log,
    head: ledger.head,
  };
  return { code: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
}

function main() {
  let input;
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    process.stderr.write(JSON.stringify({ ok: false, error: 'failed to read stdin' }) + '\n');
    process.exit(1);
  }
  const { code, stdout, stderr } = execute(input, process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main();
