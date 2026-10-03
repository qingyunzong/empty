#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { RecipeEngine } = require('./engine');

function fail(code, message) {
  fs.writeSync(1, `${JSON.stringify({ error: true, code, message })}\n`);
  process.exit(1);
}

function main(argv) {
  if (argv[0] !== 'run' || argv.length < 2) {
    fail('INVALID_ARGS', 'usage: node src/cli.js run <commands.json> [-o <result.json>]');
  }
  const inputPath = argv[1];
  let outputPath = null;
  for (let i = 2; i < argv.length; i += 1) {
    if ((argv[i] === '-o' || argv[i] === '--output') && i + 1 < argv.length) {
      outputPath = argv[i + 1];
      i += 1;
    } else {
      fail('INVALID_ARGS', `unexpected argument: ${argv[i]}`);
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    fail('FILE_UNREADABLE', `cannot read ${inputPath}: ${e.message}`);
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    fail('INVALID_JSON', `invalid JSON in ${inputPath}: ${e.message}`);
  }

  const commands = Array.isArray(doc) ? doc : doc && Array.isArray(doc.commands) ? doc.commands : null;
  if (!commands) {
    fail('INVALID_INPUT', 'expected an array of commands or an object with a "commands" array');
  }

  const engine = new RecipeEngine();
  const versions = commands.map((c) => engine.execute(c));
  const result = {
    ok: true,
    commandCount: commands.length,
    versions,
    final: engine.finalState(),
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    try {
      fs.writeFileSync(outputPath, text);
    } catch (e) {
      fail('OUTPUT_UNWRITABLE', `cannot write ${outputPath}: ${e.message}`);
    }
  } else {
    fs.writeSync(1, text);
  }
}

main(process.argv.slice(2));
