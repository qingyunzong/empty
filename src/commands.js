import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadState, saveState } from './state.js';
import { selectPlan } from './planner.js';
import { applyCertificate, buildCertificate, verifyCertificate } from './certificate.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INFEASIBLE = 2;

export const USAGE = `usage:
  node cli.js plan   <state> --node <id> --budget <n> [--out <file>]
  node cli.js commit <state> --node <id> --budget <n> [--cert <file>] [--out <file>]
  node cli.js verify <state> [--cert <file>]

exit codes: 0 = success, 1 = error / verification failed, 2 = infeasible (budget too low)`;

class CliError extends Error {}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new CliError(`missing value for --${key}`);
      flags[key] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function requireNode(flags) {
  if (flags.node === undefined) throw new CliError('missing --node <id>');
  return flags.node;
}

function requireBudget(flags) {
  if (flags.budget === undefined) throw new CliError('missing --budget <n>');
  const budget = Number(flags.budget);
  if (!Number.isFinite(budget) || budget < 0) throw new CliError(`invalid budget: "${flags.budget}"`);
  return budget;
}

function infeasibleReport(plan) {
  return {
    status: 'infeasible',
    target: plan.target,
    budget: plan.budget,
    requiredCost: plan.requiredCost,
    reason: 'minimum feasible rollback cost exceeds budget',
  };
}

function feasibleReport(plan) {
  return {
    status: 'feasible',
    target: plan.target,
    budget: plan.budget,
    cost: plan.cost,
    nodes: plan.nodes,
    paths: plan.paths,
    affected: plan.affected,
    tiedSets: plan.tiedSets,
  };
}

function cmdPlan(statePath, flags, io) {
  const state = loadState(statePath);
  const plan = selectPlan(state, requireNode(flags), requireBudget(flags));
  if (!plan.feasible) {
    const report = infeasibleReport(plan);
    writeFileSync(resolve(io.cwd, flags.out ?? 'infeasible.json'), JSON.stringify(report, null, 2) + '\n');
    io.out(JSON.stringify(report, null, 2));
    return EXIT_INFEASIBLE;
  }
  const report = feasibleReport(plan);
  if (flags.out !== undefined) writeFileSync(resolve(io.cwd, flags.out), JSON.stringify(report, null, 2) + '\n');
  io.out(JSON.stringify(report, null, 2));
  return EXIT_OK;
}

function cmdCommit(statePath, flags, io) {
  const state = loadState(statePath);
  const plan = selectPlan(state, requireNode(flags), requireBudget(flags));
  if (!plan.feasible) {
    // Budget too low: report and leave every node untouched.
    const report = infeasibleReport(plan);
    writeFileSync(resolve(io.cwd, flags.out ?? 'infeasible.json'), JSON.stringify(report, null, 2) + '\n');
    io.out(JSON.stringify(report, null, 2));
    return EXIT_INFEASIBLE;
  }
  const cert = buildCertificate(state, plan);
  applyCertificate(state, cert);
  saveState(statePath, state);
  const certPath = resolve(io.cwd, flags.cert ?? 'certificate.json');
  writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');
  io.out(JSON.stringify({ status: 'committed', certificate: certPath, ...feasibleReport(plan) }, null, 2));
  return EXIT_OK;
}

function cmdVerify(statePath, flags, io) {
  const state = loadState(statePath);
  const certPath = resolve(io.cwd, flags.cert ?? 'certificate.json');
  const cert = JSON.parse(readFileSync(certPath, 'utf8'));
  const result = verifyCertificate(state, cert);
  if (!result.ok) {
    io.err('certificate invalid:');
    for (const error of result.errors) io.err(`  - ${error}`);
    return EXIT_ERROR;
  }
  io.out('certificate valid');
  return EXIT_OK;
}

// Runs one CLI invocation. `io` carries { cwd, out(line), err(line) } so the
// same code path can be driven in-process from tests. Returns the exit code.
export function run(argv, io) {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === '--help' || command === '-h') {
      io.out(USAGE);
      return command === undefined ? EXIT_ERROR : EXIT_OK;
    }
    const { flags, positional } = parseFlags(rest);
    const statePath = positional[0];
    if (statePath === undefined) throw new CliError('missing <state> file argument');
    switch (command) {
      case 'plan':
        return cmdPlan(statePath, flags, io);
      case 'commit':
        return cmdCommit(statePath, flags, io);
      case 'verify':
        return cmdVerify(statePath, flags, io);
      default:
        throw new CliError(`unknown command "${command}"`);
    }
  } catch (error) {
    io.err(`error: ${error.message}`);
    return EXIT_ERROR;
  }
}
