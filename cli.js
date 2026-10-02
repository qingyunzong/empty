#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { settle, parseEvent } = require('./lib');

function main(argv) {
  const [, , inputPath, outputPath] = argv;
  if (!inputPath || !outputPath) {
    console.error('usage: node cli.js <events.jsonl> <settle.json>');
    return 2;
  }

  let events;
  try {
    const text = fs.readFileSync(inputPath, 'utf8');
    events = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, i) => parseEvent(line, i + 1));
  } catch (err) {
    console.error(err.code || 'E_IO', err.message);
    return 1;
  }

  let result;
  try {
    result = settle(events);
  } catch (err) {
    console.error(err.code || 'E_INTERNAL', err.message);
    return 1;
  }

  try {
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error('E_IO', err.message);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
