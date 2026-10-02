#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const {
  StateError,
  loadState,
  saveState,
  planRollback,
  applyRollback,
  verifyCertificate,
} = require('./src/rollback');

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_INFEASIBLE = 2;

const USAGE = `Usage:
  rollback plan   <state> --node <id> --budget <n> [--out plan.json] [--infeasible infeasible.json]
  rollback commit <state> --node <id> --budget <n> [--cert certificate.json] [--infeasible infeasible.json]
  rollback verify <state> --cert <certificate.json>

Exit codes: 0 success, 1 error, 2 infeasible (budget exceeded, state untouched).`;

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseBudget(raw) {
  if (raw === undefined) throw new StateError('missing required option --budget <n>');
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new StateError(`--budget must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return budget;
}

function cmdPlanOrCommit(args, commit) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      node: { type: 'string' },
      budget: { type: 'string' },
      out: { type: 'string' },
      cert: { type: 'string' },
      infeasible: { type: 'string' },
    },
  });
  const [stateFile] = parsed.positionals;
  if (!stateFile) throw new StateError('missing <state> file argument');
  const targetId = parsed.values.node;
  if (!targetId) throw new StateError('missing required option --node <id>');
  const budget = parseBudget(parsed.values.budget);
  const infeasibleFile = parsed.values.infeasible || 'infeasible.json';

  const state = loadState(stateFile);
  const plan = planRollback(state, targetId, budget);

  if (!plan.feasible) {
    writeJson(infeasibleFile, {
      feasible: false,
      reason: 'budget_exceeded',
      target: plan.target,
      budget: plan.budget,
      requiredCost: plan.totalCost,
    });
    console.error(
      `infeasible: rolling back ${plan.target} costs ${plan.totalCost}, budget is ${plan.budget}`,
    );
    console.error(`wrote ${infeasibleFile}; state unchanged`);
    return EXIT_INFEASIBLE;
  }

  if (!commit) {
    const outFile = parsed.values.out || 'plan.json';
    writeJson(outFile, plan);
    console.log(
      `plan: roll back ${plan.target} for ${plan.totalCost} (budget ${plan.budget}); ` +
        `selected [${plan.selected.join(', ')}]; wrote ${outFile}`,
    );
    return EXIT_OK;
  }

  const { state: nextState, certificate } = applyRollback(state, plan);
  saveState(stateFile, nextState);
  const certFile = parsed.values.cert || 'certificate.json';
  writeJson(certFile, certificate);
  console.log(
    `commit: rolled back ${certificate.entries.length} node(s) for ${plan.totalCost}; ` +
      `updated ${stateFile}; wrote ${certFile}`,
  );
  return EXIT_OK;
}

function cmdVerify(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: { cert: { type: 'string' } },
  });
  const [stateFile] = parsed.positionals;
  if (!stateFile) throw new StateError('missing <state> file argument');
  const certFile = parsed.values.cert;
  if (!certFile) throw new StateError('missing required option --cert <certificate.json>');

  const state = loadState(stateFile);
  let certificate;
  try {
    certificate = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  } catch (err) {
    throw new StateError(`cannot read certificate ${certFile}: ${err.message}`);
  }

  const result = verifyCertificate(state, certificate);
  if (!result.ok) {
    for (const error of result.errors) console.error(`verify: ${error}`);
    return EXIT_ERROR;
  }
  console.log(`verify: certificate OK (${certificate.entries.length} entries)`);
  return EXIT_OK;
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'plan':
        return cmdPlanOrCommit(rest, false);
      case 'commit':
        return cmdPlanOrCommit(rest, true);
      case 'verify':
        return cmdVerify(rest);
      default:
        console.error(USAGE);
        return EXIT_ERROR;
    }
  } catch (err) {
    if (err instanceof StateError) {
      console.error(`error: ${err.message}`);
      return EXIT_ERROR;
    }
    throw err;
  }
}

process.exitCode = main(process.argv.slice(2));
