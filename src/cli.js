#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PlanError } from './errors.js';
import { ProjectStore, loadStore, saveStore } from './project.js';

const DEFAULT_STATE = 'planner.state.json';

const USAGE = `exp-plan - reproducible experiment task planner

Usage:
  exp-plan create <spec.json> [--state PATH]     Create version 1 from a spec file
  exp-plan plan [--version N] [--state PATH]     Print optimal plans + certificate
  exp-plan revise <task> <cost> [--version N] [--state PATH]
                                                 Fork a new version with one task's cost changed
  exp-plan versions [--state PATH]               List known versions

Options:
  --state PATH    Version store file (default: ${DEFAULT_STATE})
`;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state' || arg === '--version') {
      const value = argv[i + 1];
      if (value === undefined) throw new PlanError('E_CLI_USAGE', `missing value for ${arg}`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new PlanError('E_CLI_USAGE', `unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (options.version !== undefined) {
    const parsed = Number(options.version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new PlanError('E_CLI_USAGE', `--version must be a positive integer, got ${JSON.stringify(options.version)}`);
    }
    options.version = parsed;
  }
  return { positional, options };
}

function dispatch(argv, emit) {
  const { positional, options } = parseArgs(argv);
  const [command, ...rest] = positional;
  const statePath = options.state ?? DEFAULT_STATE;

  switch (command) {
    case 'create': {
      const [specPath] = rest;
      if (!specPath) throw new PlanError('E_CLI_USAGE', 'create requires a spec.json path');
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      const store = new ProjectStore();
      const version = store.create(spec);
      saveStore(statePath, store);
      emit({ version, state: statePath });
      return;
    }
    case 'plan': {
      const store = loadStore(statePath);
      emit(store.plan(options.version));
      return;
    }
    case 'revise': {
      const [taskName, costRaw] = rest;
      if (!taskName || costRaw === undefined) {
        throw new PlanError('E_CLI_USAGE', 'revise requires <task> and <cost>');
      }
      const cost = Number(costRaw);
      const store = loadStore(statePath);
      const version = store.revise(taskName, cost, options.version);
      saveStore(statePath, store);
      emit({ version, revised: { task: taskName, cost }, base: options.version ?? version - 1 });
      return;
    }
    case 'versions': {
      const store = loadStore(statePath);
      emit({ versions: store.versions.map((v) => v.version) });
      return;
    }
    case undefined:
    case 'help':
    case '--help': {
      emit(USAGE.trimEnd());
      return;
    }
    default:
      throw new PlanError('E_CLI_USAGE', `unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  }
}

// Runs the CLI and captures output, so it can be driven in-process (tests)
// or from the real process entry point below.
export function runCli(argv) {
  const chunks = [];
  const emit = (value) => {
    chunks.push(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    dispatch(argv, emit);
    return { status: 0, stdout: chunks.join(''), stderr: '' };
  } catch (err) {
    const code = err instanceof PlanError ? err.code : 'E_INTERNAL';
    const message = err instanceof PlanError ? err.message : String(err?.message ?? err);
    const stderr = `${JSON.stringify({ error: { code, message } }, null, 2)}\n`;
    return { status: 1, stdout: '', stderr };
  }
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
