#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { LeaderboardEngine, EngineError } = require('./engine');

const USAGE = 'usage: node src/cli.js triggers --in <events.jsonl>';

function emitError(payload) {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function run(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'triggers') {
    emitError({ code: 'USAGE', message: USAGE });
    return 2;
  }

  let inputPath = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--in' && i + 1 < args.length) {
      inputPath = args[i + 1];
      i += 1;
    } else {
      emitError({ code: 'USAGE', message: `unknown argument: ${args[i]}. ${USAGE}` });
      return 2;
    }
  }
  if (!inputPath) {
    emitError({ code: 'USAGE', message: `missing --in <file>. ${USAGE}` });
    return 2;
  }

  let content;
  try {
    content = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    emitError({ code: 'IO_ERROR', message: `cannot read ${inputPath}: ${err.message}` });
    return 2;
  }

  const engine = new LeaderboardEngine();
  let hadError = false;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const lineNumber = index + 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      emitError({ line: lineNumber, code: 'INVALID_JSON', message: 'line is not valid JSON' });
      hadError = true;
      continue;
    }
    try {
      const actions = engine.apply(event);
      for (const action of actions) {
        process.stdout.write(`${JSON.stringify(action)}\n`);
      }
    } catch (err) {
      if (err instanceof EngineError) {
        emitError({ line: lineNumber, code: err.code, message: err.message, ...err.extra });
      } else {
        emitError({ line: lineNumber, code: 'INTERNAL', message: String(err && err.message) });
      }
      hadError = true;
    }
  }
  return hadError ? 2 : 0;
}

if (require.main === module) {
  process.exit(run(process.argv));
}

module.exports = { run };
