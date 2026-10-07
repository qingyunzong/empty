'use strict';

const fs = require('node:fs');
const { run, InputError } = require('./lib/engine');

const USAGE = 'usage: node . auth <input.json> <output.json>';

function main(argv) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'auth' || !inputPath || !outputPath) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read input: ${err.message}\n`);
    return 1;
  }
  let output;
  try {
    output = run(input);
  } catch (err) {
    if (err instanceof InputError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
