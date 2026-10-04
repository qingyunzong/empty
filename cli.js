'use strict';
const fs = require('node:fs');
const { Engine } = require('./src/engine');
const { ProtocolError } = require('./src/frames');

// Runs a scenario object; returns { report, code, error }.
// Exit codes: 0 ok, 2 protocol error, 3 insufficient funds, 4 unknown tx.
function execute(scenario) {
  let report;
  try {
    const engine = new Engine(scenario);
    report = engine.run();
  } catch (e) {
    if (e instanceof ProtocolError) return { report: null, code: 2, error: `protocol error: ${e.message}` };
    throw e;
  }
  let code = 0;
  if (report.violations.length) code = 2;
  else if (report.txs.some((t) => t.decision === 'abort' && t.reason === 'INSUFFICIENT_FUNDS')) code = 3;
  else if (report.queryResults.some((q) => q.op === 'txStatus' && !q.found)) code = 4;
  return { report, code, error: null };
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: node cli.js <scenario.json>');
    process.exit(2);
  }
  let scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  } catch (e) {
    console.error(`protocol error: cannot read/parse scenario: ${e.message}`);
    process.exit(2);
  }
  const { report, code, error } = execute(scenario);
  if (error) {
    console.error(error);
    process.exit(code);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(code);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { execute };
