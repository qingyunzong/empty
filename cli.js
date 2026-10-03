#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { processJsonl, LedgerError } = require('./lib');

// Runs the CLI and returns the process exit code (0 ok, 1 on error).
// io hooks are injectable so tests can exercise the CLI in-process.
function run(argv, io = {}) {
  const stderr = io.stderr || ((msg) => process.stderr.write(`${msg}\n`));
  const readFile = io.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = io.writeFile || ((p, c) => fs.writeFileSync(p, c));
  if (argv.length !== 4) {
    stderr('usage: node cli.js <case.jsonl> <result.json>');
    return 1;
  }
  const [, , inputPath, outputPath] = argv;
  let text;
  try {
    text = readFile(inputPath);
  } catch (err) {
    stderr(`E_IO: cannot read ${inputPath}: ${err.message}`);
    return 1;
  }
  let results;
  try {
    ({ results } = processJsonl(text));
  } catch (err) {
    if (err instanceof LedgerError) {
      stderr(`${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  try {
    writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
  } catch (err) {
    stderr(`E_IO: cannot write ${outputPath}: ${err.message}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv);
}

module.exports = { run };
