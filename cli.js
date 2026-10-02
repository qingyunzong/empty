#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const lib = require('./src/lib');

const USAGE = [
  'usage:',
  '  node cli.js candidates   --input data.json',
  '  node cli.js award        --input data.json [--state state.json]',
  '  node cli.js apply-change --state state.json --change change.json',
  '',
  'data.json:   { "order": [...], "machines": [...], "costs": [...], "budget": n }',
  'change.json: { "type": "revoke_cert", "machine": m, "process": p }',
  '           | { "type": "set_budget", "budget": n }',
].join('\n');

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, obj) {
  fs.writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

// Returns { exitCode, output }; performs state-file I/O as a side effect.
function runCli(argv) {
  const [command, ...rest] = argv;
  if (!command) return { exitCode: 2, error: USAGE };
  const { values } = parseArgs({
    args: rest,
    options: {
      input: { type: 'string' },
      state: { type: 'string' },
      change: { type: 'string' },
    },
    strict: true,
  });

  if (command === 'candidates') {
    if (!values.input) return { exitCode: 2, error: USAGE };
    return { exitCode: 0, output: lib.candidates(readJson(values.input)) };
  }

  if (command === 'award') {
    if (!values.input) return { exitCode: 2, error: USAGE };
    const data = readJson(values.input);
    const result = lib.award(data);
    if (values.state) writeJson(values.state, { data, award: result });
    return { exitCode: result.status === 'awarded' ? 0 : 1, output: result };
  }

  if (command === 'apply-change') {
    if (!values.state || !values.change) return { exitCode: 2, error: USAGE };
    const { state, transition } = lib.applyChange(readJson(values.state), readJson(values.change));
    writeJson(values.state, state);
    return { exitCode: transition.award.status === 'awarded' ? 0 : 1, output: transition };
  }

  return { exitCode: 2, error: USAGE };
}

if (require.main === module) {
  const { exitCode, output, error } = runCli(process.argv.slice(2));
  if (error) process.stderr.write(`${error}\n`);
  if (output) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = exitCode;
}

module.exports = { runCli };
