#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { runRulesLog, CliError } = require('./src/engine');

// Runs the CLI against argv (without node/script entries). `io` provides
// out/err sinks; returns the process exit code. Kept side-effect free so
// tests can drive it in-process.
function runCli(args, io) {
  if (args.length !== 2) {
    io.err('usage: node cli.js <rules.jsonl> <plan.txt>\n');
    return 2;
  }
  const [rulesPath, planPath] = args;
  let rulesText;
  let planText;
  try {
    rulesText = fs.readFileSync(rulesPath, 'utf8');
  } catch (e) {
    io.err(`cannot read ${rulesPath}: ${e.message}\n`);
    return 1;
  }
  try {
    planText = fs.readFileSync(planPath, 'utf8');
  } catch (e) {
    io.err(`cannot read ${planPath}: ${e.message}\n`);
    return 1;
  }
  try {
    const lib = runRulesLog(rulesText);
    // Whitespace is ignored; every remaining character is one event.
    const plan = planText.replace(/\s+/g, '');
    const result = lib.evaluate(plan);
    io.out(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      const loc = e.col === null ? String(e.line) : `${e.line}:${e.col}`;
      io.err(`${rulesPath}:${loc}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (require.main === module) {
  const code = runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

module.exports = { runCli };
