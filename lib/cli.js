'use strict';

const fs = require('node:fs');

const { InputError, validateInput } = require('./model');
const { solve } = require('./solver');

function main(argv) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'settle' || !inputPath || !outputPath) {
    console.error('usage: node . settle input.json output.json');
    return 1;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    console.error(`error: cannot read or parse input: ${error.message}`);
    return 1;
  }

  let valid;
  try {
    valid = validateInput(data);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const result = solve(valid);
  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`error: cannot write output: ${error.message}`);
    return 1;
  }
  return 0;
}

module.exports = { main };
