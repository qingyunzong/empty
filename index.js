'use strict';

const fs = require('node:fs');
const { run } = require('./lib/allocate');

function main(argv, io = {}) {
  const stderr = io.stderr ?? ((msg) => process.stderr.write(msg));
  const [command, inputPath, outputPath] = argv;
  if (command !== 'allocate' || !inputPath || !outputPath) {
    stderr('usage: node . allocate <input.json> <output.json>\n');
    return 2;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    stderr(`cannot read input: ${err.message}\n`);
    return 2;
  }
  let result;
  try {
    result = run(input);
  } catch (err) {
    if (err && err.code === 'INVALID_INPUT') {
      stderr(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
