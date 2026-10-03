'use strict';

const fs = require('node:fs');
const { CancellationEngine } = require('./engine');
const { ValidationError } = require('./validate');

const USAGE = 'usage: node . cancel <input.json> <output.json>';

function main(argv, streams = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, inputPath, outputPath, ...rest] = argv;
  if (command !== 'cancel' || !inputPath || !outputPath || rest.length > 0) {
    streams.stderr.write(`${USAGE}\n`);
    return 1;
  }

  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    streams.stderr.write(`error: cannot read input file: ${err.message}\n`);
    return 1;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    streams.stderr.write(`error: invalid JSON: ${err.message}\n`);
    return 1;
  }

  let output;
  try {
    output = new CancellationEngine(input).processAll();
  } catch (err) {
    if (err instanceof ValidationError) {
      streams.stderr.write(`error: invalid input: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  } catch (err) {
    streams.stderr.write(`error: cannot write output file: ${err.message}\n`);
    return 1;
  }

  streams.stdout.write(`${output.status}\n`);
  return 0;
}

module.exports = { main };
