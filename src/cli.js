#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine } = require('./engine');

function run(argv, io) {
  const args = argv.slice(2);
  const command = args[0];
  if (command !== 'triggers') {
    io.stderr(JSON.stringify({ error: 'USAGE', message: 'usage: node src/cli.js triggers --in <events.jsonl>' }) + '\n');
    return 2;
  }
  const inIdx = args.indexOf('--in');
  const inPath = inIdx >= 0 ? args[inIdx + 1] : undefined;
  if (!inPath) {
    io.stderr(JSON.stringify({ error: 'USAGE', message: 'missing required --in <events.jsonl>' }) + '\n');
    return 2;
  }

  let text;
  try {
    text = fs.readFileSync(inPath, 'utf8');
  } catch (e) {
    io.stderr(JSON.stringify({ error: 'IO_ERROR', message: e.message, path: inPath }) + '\n');
    return 2;
  }

  const engine = new Engine();
  let hadError = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (e) {
      io.stderr(JSON.stringify({ error: 'PARSE_ERROR', line: i + 1, message: e.message }) + '\n');
      hadError = true;
      continue;
    }
    const { actions, errors } = engine.apply(record);
    for (const action of actions) io.stdout(JSON.stringify(action) + '\n');
    for (const error of errors) {
      io.stderr(JSON.stringify({ line: i + 1, ...error }) + '\n');
      hadError = true;
    }
  }
  return hadError ? 2 : 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv, {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}

module.exports = { run };
