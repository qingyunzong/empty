'use strict';

const fs = require('fs');
const path = require('path');
const { runBatch, PolicyError } = require('./index');

const USAGE = 'usage: node cli.js <policy.jsonl> <events.jsonl> <out-dir>';

// Runs the CLI and returns the exit code. `io` is injectable so tests can
// capture output in-process (the sandbox forbids child processes).
function runCli(argv, io) {
  const out = io || {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
  const [policyPath, eventsPath, outDir] = argv;
  if (!policyPath || !eventsPath || !outDir) {
    out.stderr(`${USAGE}\n`);
    return 2;
  }

  let policyText;
  let eventsText;
  try {
    policyText = fs.readFileSync(policyPath, 'utf8');
    eventsText = fs.readFileSync(eventsPath, 'utf8');
  } catch (err) {
    out.stderr(`${JSON.stringify({ error: { code: 'E_IO', line: 0, message: err.message } })}\n`);
    return 1;
  }

  let result;
  try {
    result = runBatch(policyText, eventsText);
  } catch (err) {
    if (err instanceof PolicyError) {
      out.stderr(`${JSON.stringify({ error: { code: err.code, line: err.line } })}\n`);
      return 1;
    }
    throw err;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const decisionsPath = path.join(outDir, 'decisions.jsonl');
  const auditPath = path.join(outDir, 'audit.json');
  const lines = result.decisions.map((d) => JSON.stringify(d)).join('\n');
  fs.writeFileSync(decisionsPath, lines === '' ? '' : `${lines}\n`);
  fs.writeFileSync(auditPath, `${JSON.stringify(result.audit, null, 2)}\n`);

  out.stdout(
    `wrote ${result.decisions.length} decisions to ${decisionsPath}, audit root ${result.audit.root}\n`,
  );
  return 0;
}

module.exports = { runCli };
