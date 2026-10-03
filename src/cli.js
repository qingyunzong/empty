'use strict';

const fs = require('node:fs');
const { Engine, InputError } = require('./engine');

function run(argv) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'auth' || !inputPath || !outputPath || argv.length !== 3) {
    process.stderr.write('usage: node . auth <input.json> <output.json>\n');
    return 2;
  }
  try {
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const engine = new Engine(input);
    const output = engine.run();
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (err) {
    const message = err instanceof InputError ? err.message : `unexpected: ${err.message}`;
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

module.exports = { run };
