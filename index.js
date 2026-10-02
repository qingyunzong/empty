'use strict';

const fs = require('node:fs');
const { processInput } = require('./lib/plan');
const { InputError } = require('./lib/validate');

function main(argv, io = { stdout: console.log, stderr: console.error }) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'reserve' || !inputPath || !outputPath || argv.length !== 3) {
    io.stderr('usage: node . reserve <input.json> <output.json>');
    return 1;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    io.stderr(`error: cannot read input ${inputPath}: ${err.message}`);
    return 1;
  }

  let output;
  try {
    output = processInput(input);
  } catch (err) {
    if (err instanceof InputError) {
      io.stderr(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  try {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  } catch (err) {
    io.stderr(`error: cannot write output ${outputPath}: ${err.message}`);
    return 1;
  }
  io.stdout(`status: ${output.status}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
