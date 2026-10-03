'use strict';

const fs = require('node:fs');
const { validateInput, ValidationError } = require('./validate');
const { runAll } = require('./engine');

const USAGE = 'usage: node . cancel <input.json> <output.json>';

function main(argv) {
  if (argv.length !== 3 || argv[0] !== 'cancel') {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const [, inputPath, outputPath] = argv;

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read or parse input file: ${err.message}\n`);
    return 1;
  }

  try {
    validateInput(input);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`error: invalid input: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const output = runAll(input);

  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`error: cannot write output file: ${err.message}\n`);
    return 1;
  }
  return 0;
}

module.exports = { main, USAGE };
