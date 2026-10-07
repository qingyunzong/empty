#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { runAudit } = require('./lib/runner');

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node cli.js <audit.jsonl>');
    process.exit(2);
  }
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (e) {
    console.error(`ERROR cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  const { exitCode, stdout, stderr } = runAudit(lines);
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exit(exitCode);
}

main();
