#!/usr/bin/env node
// CLI: `recipe optimize recipe.dsl --json plan.json` / `recipe verify plan.json`
// Exit codes: 0 ok, 1 generic failure, 2 diagnostic (with line:col),
// 3 OVER_BUDGET, 4 INFEASIBLE.
import { readFileSync, writeFileSync } from 'node:fs';
import { Diagnostic } from './lexer.js';
import { optimizeSource, verifyPlan } from './plan.js';

export const EXIT = {
  OK: 0,
  FAILURE: 1,
  DIAGNOSTIC: 2,
  OVER_BUDGET: 3,
  INFEASIBLE: 4,
};

const STATUS_EXIT = {
  OPTIMAL: EXIT.OK,
  OVER_BUDGET: EXIT.OVER_BUDGET,
  INFEASIBLE: EXIT.INFEASIBLE,
};

function cmdOptimize(args) {
  const files = [];
  let jsonOut = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      jsonOut = args[++i];
      if (!jsonOut) {
        process.stderr.write('error: --json requires a path\n');
        return EXIT.FAILURE;
      }
    } else {
      files.push(args[i]);
    }
  }
  if (files.length !== 1) {
    process.stderr.write('usage: recipe optimize <recipe.dsl> [--json plan.json]\n');
    return EXIT.FAILURE;
  }
  let source;
  try {
    source = readFileSync(files[0], 'utf8');
  } catch (e) {
    process.stderr.write(`error: cannot read ${files[0]}: ${e.message}\n`);
    return EXIT.FAILURE;
  }
  const { plan, status } = optimizeSource(source, files[0]);
  const json = JSON.stringify(plan, null, 2) + '\n';
  if (jsonOut) {
    writeFileSync(jsonOut, json);
    process.stdout.write(`${status} (plan written to ${jsonOut})\n`);
  } else {
    process.stdout.write(json);
  }
  return STATUS_EXIT[status];
}

function cmdVerify(args) {
  if (args.length !== 1) {
    process.stderr.write('usage: recipe verify <plan.json>\n');
    return EXIT.FAILURE;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(args[0], 'utf8'));
  } catch (e) {
    process.stderr.write(`error: cannot read plan ${args[0]}: ${e.message}\n`);
    return EXIT.FAILURE;
  }
  const problems = verifyPlan(plan);
  if (problems.length === 0) {
    process.stdout.write(`OK: certificate ${plan.certificate}\n`);
    return EXIT.OK;
  }
  for (const p of problems) process.stderr.write(`verify failed: ${p}\n`);
  return EXIT.FAILURE;
}

export function main(argv) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'optimize') return cmdOptimize(args);
    if (cmd === 'verify') return cmdVerify(args);
    process.stderr.write('usage: recipe <optimize|verify> ...\n');
    return EXIT.FAILURE;
  } catch (e) {
    if (e instanceof Diagnostic) {
      process.stderr.write(e.format() + '\n');
      return EXIT.DIAGNOSTIC;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
