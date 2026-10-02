#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const { audit } = require('./src/shrink.js');
const { InvalidCommandError } = require('./src/ledger.js');

// Returns the process exit code; all output goes through io so the CLI can
// be driven in-process from tests as well as from the shell.
function run(argv, io) {
  const [command, planPath] = argv;
  if (command !== 'shrink' || !planPath) {
    io.stderr('usage: node cli.js shrink <plan.json>\n');
    return 2;
  }

  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    io.stderr(JSON.stringify({ status: 'INVALID_COMMAND', error: `cannot read or parse plan: ${err.message}` }) + '\n');
    return 1;
  }

  try {
    const report = audit(plan);
    io.stdout(JSON.stringify(report, null, 2) + '\n');
    return report.status === 'SAFE' ? 0 : 3;
  } catch (err) {
    if (err instanceof InvalidCommandError) {
      io.stderr(JSON.stringify({ status: 'INVALID_COMMAND', error: err.message }) + '\n');
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}

module.exports = { run };
