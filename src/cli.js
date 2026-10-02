#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createPlan, updatePlan } from './planner.js';
import { enumerateOptimal } from './enumerate.js';
import { normalizeScenario } from './model.js';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
}

function emit(payload, out) {
  const json = JSON.stringify(payload, null, 2);
  if (out) writeFileSync(out, json + '\n');
  process.stdout.write(json + '\n');
  if (payload.status === 'failed') process.exitCode = 1;
}

function parseArgs(argv) {
  const args = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else args.push(argv[i]);
  }
  return { args, out };
}

const { args, out } = parseArgs(process.argv.slice(2));
const command = args[0];

if (command === 'plan' && args.length === 2) {
  emit(createPlan(readJson(args[1])), out);
} else if (command === 'update' && args.length === 3) {
  emit(updatePlan(readJson(args[1]), readJson(args[2])), out);
} else if (command === 'compare' && args.length === 2) {
  const scenario = readJson(args[1]);
  const { errors, config, recipes, orders } = normalizeScenario(scenario);
  if (errors.length > 0) {
    emit({ status: 'failed', reasons: errors }, out);
  } else {
    const plan = createPlan(scenario);
    const optimal = enumerateOptimal({ orders, recipes, config });
    emit(
      {
        status: plan.status,
        reasons: plan.reasons,
        heuristic: plan.objective,
        optimal: optimal ? optimal.objective : null,
        runs: plan.runs,
        optimalRuns: optimal ? optimal.runs : null,
      },
      out,
    );
  }
} else {
  console.error('usage:');
  console.error('  node src/cli.js plan <scenario.json> [--out plan.json]');
  console.error('  node src/cli.js update <plan.json> <events.json> [--out plan.json]');
  console.error('  node src/cli.js compare <scenario.json>');
  process.exit(2);
}
