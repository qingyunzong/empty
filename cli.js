#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { runScript } = require('./src/engine');
const { MonitorError, EXIT_CONSISTENCY } = require('./src/monitor');

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node cli.js <script.jsonl>');
    process.exit(2);
  }
  let records;
  try {
    records = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
  } catch (e) {
    console.error(`invalid JSONL input: ${e.message}`);
    process.exit(2);
  }
  try {
    runScript(records, {
      walPath: file + '.wal',
      ckptPath: file + '.ckpt',
      out: (status) => console.log(JSON.stringify(status)),
    });
  } catch (e) {
    if (e instanceof MonitorError || (e && e.code === EXIT_CONSISTENCY)) {
      fs.writeSync(2, `E_CONSISTENCY: ${e.message}\n`);
      process.exitCode = EXIT_CONSISTENCY;
      return;
    }
    throw e;
  }
}

main();
