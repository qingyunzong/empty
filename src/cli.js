#!/usr/bin/env node
'use strict';

// CLI: node src/cli.js < req.json > res.json
// Reads one request JSON from stdin, writes the response JSON to stdout.

const { runRequest } = require('./engine');

// Pure entry point, unit-testable in-process.
// Returns { code, output }: exit code and the text to write to stdout.
function execute(input) {
  let req;
  try {
    req = JSON.parse(input);
  } catch (e) {
    return {
      code: 1,
      output: JSON.stringify({
        ok: false,
        error: { code: 'E_PARSE', message: `invalid JSON on stdin: ${e.message}` },
        results: [],
      }) + '\n',
    };
  }
  return { code: 0, output: JSON.stringify(runRequest(req), null, 2) + '\n' };
}

function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    const { code, output } = execute(data);
    process.stdout.write(output);
    if (code !== 0) process.exit(code);
  });
}

if (require.main === module) main();

module.exports = { execute };
