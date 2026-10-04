'use strict';

const fs = require('node:fs');
const { settle } = require('./settle');
const { ValidationError } = require('./validate');

function main(argv) {
  if (argv.length !== 3 || argv[0] !== 'settle') {
    process.stderr.write('usage: node . settle <input.json> <output.json>\n');
    return 1;
  }
  const [, inputPath, outputPath] = argv;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read or parse input "${inputPath}": ${err.message}\n`);
    return 1;
  }

  let output;
  try {
    output = settle(raw);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`error: invalid input: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`error: cannot write output "${outputPath}": ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`${output.status}\n`);
  return 0;
}

module.exports = { main };
