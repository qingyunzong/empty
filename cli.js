#!/usr/bin/env node
'use strict';
// CLI for the reproducibility DAG. Commands take JSON payloads:
//   node cli.js add        '{"id":"extract","codeVersion":"1","inputs":[],"params":{}}'
//   node cli.js run        '{"id":"extract"}'        (or '{"all":true}')
//   node cli.js invalidate '{"id":"extract"}'
//   node cli.js audit
//   node cli.js gc
// State file defaults to ./dag.state.json (override with --state <path>).
// Errors are reported as {"error":{"code":"CYCLE"|"MISSING_INPUT"|"BAD_CERT"}}.

const fs = require('node:fs');
const path = require('node:path');
const dag = require('./src/dag.js');

function parseArgs(argv) {
  const args = [...argv];
  let statePath = path.resolve(process.cwd(), 'dag.state.json');
  const i = args.indexOf('--state');
  if (i !== -1) {
    statePath = path.resolve(process.cwd(), args[i + 1]);
    args.splice(i, 2);
  }
  const [command, payload] = args;
  return { command, payload, statePath };
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return dag.createState();
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

function main() {
  const { command, payload, statePath } = parseArgs(process.argv.slice(2));
  const state = loadState(statePath);
  const input = payload ? JSON.parse(payload) : {};
  let out;
  switch (command) {
    case 'add':
      out = dag.addNode(state, input);
      break;
    case 'run':
      out = input.all ? dag.runAll(state, input.runner) : dag.runNode(state, input.id, input.runner);
      break;
    case 'invalidate':
      out = { invalidated: dag.invalidate(state, input.id) };
      break;
    case 'audit':
      out = dag.audit(state);
      break;
    case 'gc':
      out = dag.gc(state);
      break;
    default:
      throw new dag.DagError('MISSING_INPUT', `unknown command: ${command}`);
  }
  saveState(statePath, state);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  const code = err.code || 'MISSING_INPUT';
  process.stderr.write(JSON.stringify({ error: { code, message: err.message } }) + '\n');
  process.exit(1);
}
