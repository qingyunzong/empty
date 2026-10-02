#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ClearingError, EXIT_CODES } from '../src/errors.js';
import { planToDir, commitRounds, recoverState, verifyState } from '../src/store.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new ClearingError('INVALID', `unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'plan': {
      if (!args.input || !args.state) throw new ClearingError('INVALID', 'plan requires --input <file> and --state <dir>');
      const scenario = JSON.parse(fs.readFileSync(args.input, 'utf8'));
      const maxRounds = args['max-rounds'] !== undefined ? Number(args['max-rounds']) : undefined;
      return { status: 0, stdout: render(planToDir(args.state, scenario, { maxRounds })) };
    }
    case 'commit': {
      if (!args.state) throw new ClearingError('INVALID', 'commit requires --state <dir>');
      const maxCommits = args.rounds !== undefined ? Number(args.rounds) : Infinity;
      const result = commitRounds(args.state, { maxCommits, crashAfterWrite: args['crash-after-write'] === true });
      return { status: result.crashed ? 3 : 0, stdout: render(result) };
    }
    case 'recover': {
      if (!args.state) throw new ClearingError('INVALID', 'recover requires --state <dir>');
      return { status: 0, stdout: render(recoverState(args.state)) };
    }
    case 'verify': {
      if (!args.state) throw new ClearingError('INVALID', 'verify requires --state <dir>');
      return { status: 0, stdout: render(verifyState(args.state)) };
    }
    default:
      throw new ClearingError('INVALID', `unknown command "${cmd ?? ''}"; expected plan|commit|recover|verify`);
  }
}

export function runSafe(argv) {
  try {
    return { stderr: '', ...run(argv) };
  } catch (err) {
    if (err instanceof ClearingError) {
      return { status: EXIT_CODES[err.code] ?? 1, stdout: '', stderr: `${JSON.stringify({ error: err.code, message: err.message })}\n` };
    }
    return { status: 1, stdout: '', stderr: `${JSON.stringify({ error: 'INTERNAL', message: String((err && err.message) || err) })}\n` };
  }
}

export function main() {
  const result = runSafe(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
