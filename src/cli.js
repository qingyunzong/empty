#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine } = require('./engine');

function emitError(line) {
  process.stderr.write(JSON.stringify(line) + '\n');
}

function main(argv) {
  const args = argv.slice(2);
  const command = args[0];
  if (command !== 'profiles') {
    emitError({
      type: 'ERROR',
      code: 'USAGE',
      message: 'usage: node src/cli.js profiles --in <events.jsonl>',
    });
    return 2;
  }
  const inIdx = args.indexOf('--in');
  const inPath = inIdx >= 0 ? args[inIdx + 1] : undefined;
  if (!inPath) {
    emitError({ type: 'ERROR', code: 'USAGE', message: 'missing required --in <file>' });
    return 2;
  }

  let text;
  try {
    text = fs.readFileSync(inPath, 'utf8');
  } catch (err) {
    emitError({ type: 'ERROR', code: 'IO_ERROR', message: `cannot read ${inPath}: ${err.message}` });
    return 2;
  }

  const engine = new Engine();
  const outLines = [];
  let hadError = false;

  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      emitError({
        type: 'ERROR',
        code: 'INVALID_JSON',
        message: `line ${idx + 1}: ${err.message}`,
      });
      hadError = true;
      continue;
    }
    const { outputs, errors } = engine.apply(event);
    for (const output of outputs) outLines.push(JSON.stringify(output));
    for (const error of errors) {
      emitError(error);
      hadError = true;
    }
  }

  if (outLines.length > 0) {
    process.stdout.write(outLines.join('\n') + '\n');
  }
  return hadError ? 2 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
