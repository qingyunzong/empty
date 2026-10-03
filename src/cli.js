#!/usr/bin/env node
// CLI:
//   optimize <recipe.dsl> [--json plan.json]   solve and emit an auditable plan
//   verify <plan.json>                         re-check certificate and optimality
//
// Exit codes:
//   0  optimal plan found and written / plan verified
//   1  domain result: INFEASIBLE, OVER_BUDGET, or verification failure
//   2  diagnostic: lexical/parse/type/macro/IO errors (message carries line:col)

import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { Diagnostic } from './lexer.js';
import { runPipeline } from './pipeline.js';
import { buildPlan, verifyPlan } from './plan.js';
import { formatRational } from './rational.js';

const USAGE = `usage:
  optimize <recipe.dsl> [--json plan.json]
  verify <plan.json>`;

// Synchronous writes so output is never lost behind process exit, even in
// restricted sandboxes where async pipe writes are not serviced.
function out(message) {
  writeSync(1, message);
}

function err(message) {
  writeSync(2, message);
}

class DiagnosticExit extends Error {}

function failDiagnostic(message) {
  err(`${message}\n`);
  process.exitCode = 2;
  throw new DiagnosticExit();
}

function cmdOptimize(args) {
  if (args.length < 1) failDiagnostic(`error: missing recipe file\n${USAGE}`);
  const file = args[0];
  let jsonOut = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') {
      jsonOut = args[++i];
      if (!jsonOut) failDiagnostic('error: --json requires a path');
    } else {
      failDiagnostic(`error: unknown option '${args[i]}'\n${USAGE}`);
    }
  }
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    failDiagnostic(`${file}: error: cannot read file: ${e.message}`);
  }
  let model;
  let result;
  try {
    ({ model, result } = runPipeline(source, file));
  } catch (e) {
    if (e instanceof Diagnostic) failDiagnostic(e.toString());
    throw e;
  }

  if (result.status === 'INFEASIBLE') {
    out(`${JSON.stringify({ status: 'INFEASIBLE' })}\n`);
    process.exitCode = 1;
    return;
  }
  if (result.status === 'OVER_BUDGET') {
    const summary = {
      status: 'OVER_BUDGET',
      min_cost: formatRational(result.plan.cost),
      budget: formatRational(result.budget),
    };
    out(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
    return;
  }

  const plan = buildPlan({ source, file, model, result });
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, json);
    } catch (e) {
      failDiagnostic(`${jsonOut}: error: cannot write file: ${e.message}`);
    }
  }
  out(json);
}

function cmdVerify(args) {
  if (args.length < 1) failDiagnostic(`error: missing plan file\n${USAGE}`);
  const file = args[0];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    failDiagnostic(`${file}: error: cannot read file: ${e.message}`);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    failDiagnostic(`${file}: error: invalid JSON: ${e.message}`);
  }
  let outcome;
  try {
    outcome = verifyPlan(plan, runPipeline);
  } catch (e) {
    if (e instanceof Diagnostic) failDiagnostic(`${file}: error: embedded source failed to compile: ${e.toString()}`);
    throw e;
  }
  if (!outcome.ok) {
    for (const r of outcome.reasons) err(`${file}: verification failed: ${r}\n`);
    process.exitCode = 1;
    return;
  }
  out(`OK: certificate valid; plan re-optimized to the same optimum\n`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'optimize': return cmdOptimize(rest);
      case 'verify': return cmdVerify(rest);
      case undefined:
      case '--help':
      case '-h':
        out(`${USAGE}\n`);
        process.exitCode = cmd === undefined ? 2 : 0;
        return;
      default:
        failDiagnostic(`error: unknown command '${cmd}'\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof DiagnosticExit) return;
    throw e;
  }
}

main(process.argv.slice(2));
