#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { InputError, PlanError } = require('./src/errors');
const { runCheck } = require('./src/run');
const { savePlan, loadPlan } = require('./src/plan');

const USAGE = `Usage:
  node cli.js <old.json> <new.json> <budget> [m] [--plan <path>]
  node cli.js load [plan.json]

Exit codes: 0 ok | 7 invalid input (negative budget, missing state, non-integer cost)
            8 INFEASIBLE (budget insufficient) | 2 plan load rejected | 1 usage/other`;

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new InputError(`${label}: cannot read file ${filePath}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new InputError(`${label}: invalid JSON in ${filePath}`);
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cmdRun(args) {
  const positional = [];
  let planPath = 'plan.json';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--plan') {
      if (i + 1 >= args.length) throw new InputError('--plan requires a path');
      planPath = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length < 3 || positional.length > 4) {
    process.stderr.write(USAGE + '\n');
    return 1;
  }
  const [oldPath, newPath, budgetRaw, mRaw] = positional;
  const budget = Number(budgetRaw);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new InputError(`invalid budget: ${budgetRaw} (must be a non-negative integer)`);
  }
  let m;
  if (mRaw !== undefined) {
    m = Number(mRaw);
    if (!Number.isInteger(m) || m < 0) {
      throw new InputError(`invalid m: ${mRaw} (must be a non-negative integer)`);
    }
  }
  const oldRaw = readJson(oldPath, 'old');
  const newRaw = readJson(newPath, 'new');
  const { result, m: mUsed } = runCheck(oldRaw, newRaw, budget, m);
  if (!result.feasible) {
    process.stdout.write('INFEASIBLE\n');
    return 8;
  }
  const plan = {
    version: 1,
    inputs: { old: sha256File(oldPath), new: sha256File(newPath) },
    budget,
    m: mUsed,
    equal: result.equal,
    witness: result.witness,
    diffStates: result.diffStates,
    tasks: result.tasks,
    cost: result.cost,
  };
  const planHash = savePlan(planPath, plan);
  const output = {
    equal: result.equal,
    witness: result.witness,
    tasks: result.tasks,
    cost: result.cost,
    planHash,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  return 0;
}

function cmdLoad(args) {
  const planPath = args[0] || 'plan.json';
  const plan = loadPlan(planPath);
  process.stdout.write(JSON.stringify({ ok: true, plan }, null, 2) + '\n');
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  try {
    if (args[0] === 'load') return cmdLoad(args.slice(1));
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      process.stderr.write(USAGE + '\n');
      return args.length === 0 ? 1 : 0;
    }
    return cmdRun(args);
  } catch (err) {
    if (err instanceof InputError) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      return 7;
    }
    if (err instanceof PlanError) {
      process.stderr.write(`INVALID PLAN: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`FATAL: ${err.stack || err}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
