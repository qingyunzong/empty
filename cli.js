#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine } = require('./lib');

function die(message) {
  fs.writeSync(2, message + '\n');
  process.exit(1);
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    die('usage: node cli.js <events.jsonl> <final.json>');
  }

  let text;
  try {
    text = fs.readFileSync(input, 'utf8');
  } catch (err) {
    die(`E_IO: cannot read ${input}: ${err.message}`);
  }

  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      events.push({ event: JSON.parse(line), line: i + 1 });
    } catch (err) {
      die(`E_PARSE: line ${i + 1}: ${err.message}`);
    }
  }

  if (events.length === 0 || events[0].event.type !== 'config') {
    die('E_SCHEMA: first non-empty line must be a config event');
  }

  let engine;
  try {
    engine = new Engine(events[0].event);
  } catch (err) {
    die(`E_CONFIG: ${err.message}`);
  }
  engine._chain(events[0].event, 'OK');

  for (const { event, line } of events.slice(1)) {
    engine.apply(event, line);
  }

  const result = engine.finalize();
  try {
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    die(`E_IO: cannot write ${output}: ${err.message}`);
  }

  const states = Object.entries(result.requests)
    .map(([id, r]) => `${id}=${r.state}`)
    .join(' ');
  process.stdout.write(`audit_hash=${result.audit_hash}\n`);
  process.stdout.write(`requests: ${states || '(none)'}\n`);
  process.stdout.write(`failures: ${result.failures.length}\n`);
}

main();
