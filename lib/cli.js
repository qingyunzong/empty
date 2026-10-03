'use strict';

const fs = require('node:fs');
const { normalize, ValidationError } = require('./model');
const { run } = require('./engine');

function main(argv) {
  const [cmd, inputPath, outputPath, ...rest] = argv;
  if (cmd !== 'retry' || !inputPath || !outputPath || rest.length > 0) {
    process.stderr.write('usage: node . retry <input.json> <output.json>\n');
    return 1;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read or parse input: ${err.message}\n`);
    return 1;
  }

  let model;
  try {
    model = normalize(raw);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const output = run(model);
  try {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`error: cannot write output: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`status: ${output.status}\n`);
  return 0;
}

module.exports = { main };
