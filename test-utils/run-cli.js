'use strict';
// Runs the real CLI entry logic in-process: main() parses argv, reads the
// plan file, validates, explores, writes to stdout and returns the exit code.
// (Child-process spawning is unavailable in some sandboxes, so we capture
// process.stdout/stderr writes instead.)
const { main } = require('../src/cli');

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (typeof rest[1] === 'function') rest[1]();
    else if (typeof rest[0] === 'function') rest[0]();
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (typeof rest[1] === 'function') rest[1]();
    else if (typeof rest[0] === 'function') rest[0]();
    return true;
  };
  let status;
  try {
    status = main(args);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return { status, stdout, stderr };
}

module.exports = { runCli };
