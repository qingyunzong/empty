'use strict';

const fs = require('node:fs');
const { reserve, InputError } = require('./lib/reserve');

function main(argv) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'reserve' || !inputPath || !outputPath) {
    process.stderr.write('usage: node . reserve <input.json> <output.json>\n');
    return 1;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read input: ${err.message}\n`);
    return 1;
  }
  let result;
  try {
    result = reserve(input);
  } catch (err) {
    if (err instanceof InputError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  try {
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`error: cannot write output: ${err.message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
