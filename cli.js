#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { replay, SettleError } = require('./lib');

function parseJsonl(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      throw new SettleError('E_PARSE', `line ${i + 1}: invalid JSON`);
    }
  });
  return events;
}

function main(argv) {
  const [input, output] = argv.slice(2);
  if (!input || !output) {
    process.stderr.write('usage: node cli.js <events.jsonl> <settle.json>\n');
    return 2;
  }
  try {
    const events = parseJsonl(fs.readFileSync(input, 'utf8'));
    const result = replay(events);
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err && err.code) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main, parseJsonl };
