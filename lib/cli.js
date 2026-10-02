'use strict';

const fs = require('node:fs');
const { runAllocation } = require('./allocator');

// Returns the process exit code instead of calling process.exit so the CLI
// can be exercised in-process from tests.
function main(argv, io = { stderr: (m) => console.error(m), stdout: (m) => console.log(m) }) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'allocate' || !inputPath || !outputPath) {
    io.stderr('Usage: node . allocate <input.json> <output.json>');
    return 2;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    io.stderr(`cannot read input ${inputPath}: ${err.message}`);
    return 2;
  }
  let output;
  try {
    output = runAllocation(input);
  } catch (err) {
    if (err && err.code === 'INVALID_INPUT') {
      io.stderr(`invalid input: ${err.message}`);
      return 1;
    }
    throw err;
  }
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  io.stdout(`status=${output.status} -> ${outputPath}`);
  return 0;
}

module.exports = { main };
