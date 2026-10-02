#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  FlowError,
  compileFlow,
  validateLog,
  judgeEvents,
  makeProof,
  verifyProof,
} = require('./lib');

const USAGE = 'usage: node cli.js judge <flow.json> <log.jsonl> [--verify proof.json]';

// returns { code, output }; throws nothing for expected error paths
function run(argv) {
  const [cmd, flowPath, logPath, ...rest] = argv;
  if (cmd !== 'judge' || !flowPath || !logPath) {
    return { code: 2, output: { error: 'USAGE', message: USAGE } };
  }
  const verifyIdx = rest.indexOf('--verify');
  const proofPath = verifyIdx >= 0 ? rest[verifyIdx + 1] : null;
  if (verifyIdx >= 0 && !proofPath) {
    return { code: 2, output: { error: 'USAGE', message: USAGE } };
  }

  try {
    const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
    const events = fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const compiled = compileFlow(flow);
    validateLog(events);
    const result = judgeEvents(compiled, events);
    const proof = makeProof(compiled, events, result);

    const out = {
      verdict: result.verdict,
      prefix: result.prefix,
      continuations: result.continuations,
      proof,
    };
    if (result.failingEvent) out.failingEvent = result.failingEvent;
    if (result.path) out.path = result.path;

    let code = result.verdict === 'accept' ? 0 : 1;

    if (proofPath) {
      const given = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
      out.verification = verifyProof(flow, events, given);
      if (!out.verification.ok) code = 3;
    }
    return { code, output: out };
  } catch (err) {
    const code = err instanceof FlowError ? err.code : 'ERROR';
    return { code: 2, output: { error: code, message: err.message } };
  }
}

if (require.main === module) {
  const { code, output } = run(process.argv.slice(2));
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = code;
}

module.exports = { run };
