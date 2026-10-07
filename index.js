'use strict';

const fs = require('node:fs');
const { solveHistory, InputError } = require('./lib/solver');

function main(argv) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'history' || !inputPath || !outputPath) {
    console.error('usage: node . history <input.json> <output.json>');
    return 2;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    console.error(`error: cannot read input file: ${err.message}`);
    return 1;
  }

  let result;
  try {
    result = solveHistory(input);
  } catch (err) {
    if (err instanceof InputError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { solveHistory, InputError, main };
