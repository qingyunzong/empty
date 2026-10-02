#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LineError } = require('./lib/jsonl');
const { loadPolicy } = require('./lib/policy');
const { parseEvents, decide } = require('./lib/evaluate');
const { buildAudit } = require('./lib/audit');

// Runs the CLI. Returns the process exit code; diagnostics go to `stderr`.
// Dependencies are injectable so tests can exercise the CLI in-process.
function run(argv, deps = {}) {
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const fsx = deps.fs ?? fs;

  const fail = (err) => {
    if (err instanceof LineError) {
      stderr(JSON.stringify({ error: { code: err.code, line: err.line } }) + '\n');
    } else {
      stderr(JSON.stringify({ error: { code: 'E_IO', line: 0, message: String(err.message) } }) + '\n');
    }
    return 1;
  };

  const [policyPath, eventsPath, outDir] = argv;
  if (!policyPath || !eventsPath || !outDir) {
    stderr('usage: node cli.js <policy.jsonl> <events.jsonl> <outDir>\n');
    return 2;
  }

  let policyText, eventsText;
  try {
    policyText = fsx.readFileSync(policyPath, 'utf8');
    eventsText = fsx.readFileSync(eventsPath, 'utf8');
  } catch (err) {
    return fail(err);
  }

  let policy, events;
  try {
    policy = loadPolicy(policyText);
  } catch (err) {
    return fail(err);
  }
  try {
    events = parseEvents(eventsText);
  } catch (err) {
    return fail(err);
  }

  const decisions = events.map((event) => decide(policy, event));
  const { lines, audit } = buildAudit(decisions);

  fsx.mkdirSync(outDir, { recursive: true });
  fsx.writeFileSync(path.join(outDir, 'decisions.jsonl'), lines.map((l) => l + '\n').join(''));
  fsx.writeFileSync(path.join(outDir, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
