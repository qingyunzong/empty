#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { solve } from './src/solver.js';
import { makeCertificate, verifyCertificate } from './src/certificate.js';
import { PlannerError } from './src/errors.js';
import {
  initState, solveState, insertJob, pin, unpin,
  forkCheckpoint, restoreCheckpoint, mergeCheckpoint,
} from './src/state.js';

const EXIT = { INVALID_INPUT: 1, UNSAT: 2, PENDING: 3, CONFLICT: 4, INVALID: 5 };

function readJSON(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new PlannerError('INVALID_INPUT', `cannot read file ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new PlannerError('INVALID_INPUT', `invalid JSON in ${path}: ${err.message}`);
  }
}

function loadState(path) {
  if (!existsSync(path)) throw new PlannerError('INVALID_INPUT', `no state file at ${path}; run init first`);
  return readJSON(path);
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exitCode = code;
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function solveExitCode(status) {
  if (status === 'SAT') return 0;
  return EXIT[status] ?? 1;
}

function main(argv) {
  const [command, ...args] = argv;
  const { flags, rest } = parseFlags(args);

  switch (command) {
    case 'solve': {
      const [instancePath] = rest;
      if (!instancePath) throw new PlannerError('INVALID_INPUT', 'usage: solve <instance.json> [--pins pins.json] [--max-nodes N] [--max-cert-bytes N] [--cert out.json]');
      const instance = readJSON(instancePath);
      const pins = flags.pins ? readJSON(flags.pins) : {};
      const maxNodes = flags['max-nodes'] !== undefined ? Number(flags['max-nodes']) : Infinity;
      const maxCertBytes = flags['max-cert-bytes'] !== undefined ? Number(flags['max-cert-bytes']) : Infinity;
      if (!(maxNodes >= 0) || !(maxCertBytes >= 0)) {
        throw new PlannerError('INVALID_INPUT', 'budgets must be non-negative numbers');
      }
      const result = solve(instance, { pins, maxNodes, maxCertBytes });
      const cert = makeCertificate(instance, pins, result);
      if (flags.cert) writeFileSync(flags.cert, JSON.stringify(cert, null, 2) + '\n');
      emit({ status: result.status, plan: result.plan, nodes: result.nodes, head: result.head }, solveExitCode(result.status));
      return;
    }
    case 'verify': {
      const [certPath] = rest;
      if (!certPath) throw new PlannerError('INVALID_INPUT', 'usage: verify <cert.json>');
      const verdict = verifyCertificate(readJSON(certPath));
      emit(verdict, verdict.status === 'VALID' ? 0 : EXIT.INVALID);
      return;
    }
    case 'init': {
      const [statePath, instancePath] = rest;
      if (!statePath || !instancePath) throw new PlannerError('INVALID_INPUT', 'usage: init <state.json> <instance.json>');
      const state = initState(readJSON(instancePath));
      saveState(statePath, state);
      emit({ status: 'INIT' });
      return;
    }
    case 'insert-job': {
      const [statePath, jobPath] = rest;
      if (!statePath || !jobPath) throw new PlannerError('INVALID_INPUT', 'usage: insert-job <state.json> <job.json>');
      const state = loadState(statePath);
      const result = insertJob(state, readJSON(jobPath));
      saveState(statePath, state);
      emit(result, solveExitCode(result.status));
      return;
    }
    case 'pin':
    case 'unpin': {
      const [statePath, step, param] = rest;
      if (!statePath || !step) throw new PlannerError('INVALID_INPUT', `usage: ${command} <state.json> <step> [param]`);
      const state = loadState(statePath);
      const result = command === 'pin' ? pin(state, step, param) : unpin(state, step);
      saveState(statePath, state);
      emit(result, solveExitCode(result.status));
      return;
    }
    case 'fork-checkpoint':
    case 'restore-checkpoint':
    case 'merge-checkpoint': {
      const [statePath, name] = rest;
      if (!statePath || !name) throw new PlannerError('INVALID_INPUT', `usage: ${command} <state.json> <name>`);
      const state = loadState(statePath);
      const fn = command === 'fork-checkpoint' ? forkCheckpoint
        : command === 'restore-checkpoint' ? restoreCheckpoint
        : mergeCheckpoint;
      const result = fn(state, name);
      saveState(statePath, state);
      emit(result);
      return;
    }
    default:
      throw new PlannerError('INVALID_INPUT', `unknown command ${JSON.stringify(command ?? '')}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof PlannerError) {
    emit(err.toJSON(), EXIT[err.status] ?? 1);
  } else {
    emit({ status: 'INVALID_INPUT', message: String(err && err.message ? err.message : err) }, 1);
  }
}
