'use strict';

const fs = require('node:fs');
const { runScript } = require('./src/cliapp');

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node cli.js <in.jsonl>\n');
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'BAD_INPUT', message: `cannot read ${file}: ${e.message}` }) + '\n');
    process.exit(2);
  }
  const { exitCode, output } = runScript(text);
  process.stdout.write(output);
  process.exit(exitCode);
}

main();
