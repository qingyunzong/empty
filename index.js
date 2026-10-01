'use strict';

const fs = require('node:fs');
const { solve, InputError } = require('./lib/solver');

function main(argv) {
  const [command, inputPath, outputPath] = argv.slice(2);
  if (command !== 'audit' || !inputPath || !outputPath) {
    console.error('usage: node . audit <input.json> <output.json>');
    process.exitCode = 2;
    return;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = solve(input);
  } catch (err) {
    if (err instanceof InputError) {
      console.error(`input error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${result.status} ${result.voucherNo} -> ${outputPath}`);
}

main(process.argv);
