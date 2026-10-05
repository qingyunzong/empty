#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine, CommandError } = require('./engine');

function fail(code, message) {
  // Synchronous write so the payload is not lost when the process exits
  // while stdout is a pipe.
  fs.writeSync(1, `${JSON.stringify({ error: true, code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] !== 'run') {
    fail('E_USAGE', 'usage: node src/cli.js run <commands.json> -o <result.json>');
  }
  const rest = argv.slice(1);
  let input = null;
  let output = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '-o' || rest[i] === '--output') {
      output = rest[i + 1];
      i += 1;
    } else if (input === null) {
      input = rest[i];
    } else {
      fail('E_USAGE', `unexpected argument: ${rest[i]}`);
    }
  }
  if (!input) fail('E_USAGE', 'missing input commands.json path');
  if (!output) fail('E_USAGE', 'missing -o <result.json> output path');
  return { input, output };
}

function main() {
  const { input, output } = parseArgs(process.argv.slice(2));

  let raw;
  try {
    raw = fs.readFileSync(input, 'utf8');
  } catch (err) {
    fail('E_INPUT', `cannot read commands file ${input}: ${err.message}`);
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    fail('E_INPUT', `invalid JSON in ${input}: ${err.message}`);
  }

  const commands = Array.isArray(doc) ? doc : doc && doc.commands;
  if (!Array.isArray(commands)) {
    fail('E_INPUT', 'commands file must be a JSON array or an object with a "commands" array');
  }

  const engine = new Engine();
  const versions = [];
  for (const cmd of commands) {
    let record;
    try {
      record = engine.execute(cmd);
    } catch (err) {
      if (err instanceof CommandError) {
        fail(err.code, `command ${versions.length + 1} (${cmd && cmd.op}): ${err.message}`);
      }
      throw err;
    }
    const invalid = [...engine.invalid].sort();
    const values = {};
    for (const [name, value] of engine.values) values[name] = value;
    versions.push({
      version: record.version,
      command: cmd,
      status: invalid.length === 0 ? 'ok' : 'invalid',
      values,
      invalid,
      diff: record.diff,
      recomputed: record.recomputed,
      certificate: record.certificate,
    });
  }

  const last = versions[versions.length - 1];
  const result = {
    versions,
    final: last
      ? {
          version: last.version,
          status: last.status,
          values: last.values,
          invalid: last.invalid,
          certificate: last.certificate,
        }
      : { version: 0, status: 'ok', values: {}, invalid: [], certificate: engine.certificate(0) },
  };

  try {
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    fail('E_OUTPUT', `cannot write result file ${output}: ${err.message}`);
  }
}

main();
