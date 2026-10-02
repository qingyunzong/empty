#!/usr/bin/env node
// Evidence-guard CLI.
//
// Usage:
//   node src/cli.js --script script.json [--state state.json] [--crash N] [--dump]
//
// Input:  JSON script (transactions of nested blocks, guards, assignments)
//         plus initial observations.
// Output: {"ok": true, "observations": {...}} on success,
//         {"ok": false, "error": "..."} on any failure.
// --dump    print the instruction listing and exit.
// --crash N exit (code 42) after executing the Nth instruction, before commit.
//           Committed transactions are persisted in the state file; rerunning
//           without --crash resumes after the last committed transaction.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkScript, StaticTypeError } from './lang.js';
import { compile, dump } from './compile.js';
import { execute, VmError } from './vm.js';

export const CRASH_EXIT_CODE = 42;

export class CrashSignal extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'CrashSignal';
  }
}

function parseArgs(argv) {
  const args = { script: null, state: null, crash: 0, dump: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dump') {
      args.dump = true;
    } else if (arg === '--crash') {
      args.crash = Number(argv[++i]);
      if (!Number.isInteger(args.crash) || args.crash < 1) {
        throw new Error('--crash expects a positive integer');
      }
    } else if (arg === '--state') {
      args.state = argv[++i];
    } else if (arg === '--script') {
      args.script = argv[++i];
    } else if (!arg.startsWith('--') && args.script === null) {
      args.script = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.script) throw new Error('missing --script <path>');
  return args;
}

function writeState(statePath, state) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

// Runs the CLI and returns { code, stdout } without touching process state,
// so it can be driven both from the real entry point and from tests.
export function run(argv) {
  const failure = (error) => ({ code: 1, stdout: `${JSON.stringify({ ok: false, error })}\n` });

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return failure(err.message);
  }

  let script;
  try {
    script = JSON.parse(fs.readFileSync(args.script, 'utf8'));
  } catch (err) {
    return failure(`cannot read script: ${err.message}`);
  }

  try {
    checkScript(script);
  } catch (err) {
    if (err instanceof StaticTypeError) return failure(`type error: ${err.message}`);
    throw err;
  }

  const { transactions, code } = compile(script);

  if (args.dump) {
    return { code: 0, stdout: `${dump(code)}\n` };
  }

  const statePath = args.state ?? `${args.script}.state.json`;
  let committed = 0;
  let observations = script.observations ?? {};
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    committed = state.committed ?? 0;
    observations = state.observations;
    if (committed > transactions.length) {
      return failure(
        `state file commits (${committed}) exceed script transactions (${transactions.length})`,
      );
    }
  }

  const counter = { executed: 0 };
  try {
    for (let i = committed; i < transactions.length; i += 1) {
      observations = execute(transactions[i].code, observations, {
        counter,
        crashAt: args.crash,
        onCrash: () => {
          throw new CrashSignal();
        },
        onCommit: (_name, obs) => writeState(statePath, { committed: i + 1, observations: obs }),
      });
    }
  } catch (err) {
    if (err instanceof CrashSignal) {
      return { code: CRASH_EXIT_CODE, stdout: '' };
    }
    if (err instanceof VmError) {
      return failure(`transaction rolled back: ${err.message}`);
    }
    throw err;
  }

  return { code: 0, stdout: `${JSON.stringify({ ok: true, observations }, null, 2)}\n` };
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (invokedAsScript) {
  const { code, stdout } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  process.exitCode = code;
}
