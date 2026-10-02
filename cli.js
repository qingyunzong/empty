#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Ledger, StructuralError } = require('./src/ledger');

function main(argv) {
  const [input, output] = argv.slice(2);
  if (!input || !output) {
    console.error('usage: node cli.js <events.jsonl> <final.json>');
    return 1;
  }
  let text;
  try {
    text = fs.readFileSync(input, 'utf8');
  } catch (err) {
    console.error(`E_IO: cannot read ${input}: ${err.message}`);
    return 1;
  }
  const ledger = new Ledger();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      console.error(`E_PARSE: line ${i + 1}: ${err.message}`);
      return 1;
    }
    let transition;
    try {
      transition = ledger.apply(event);
    } catch (err) {
      if (err instanceof StructuralError) {
        console.error(`line ${i + 1}: ${err.code}: ${err.message}`);
        return 1;
      }
      throw err;
    }
    if (!transition.ok) {
      console.error(`line ${i + 1}: ${transition.error}: ${transition.message}`);
    }
  }
  try {
    fs.writeFileSync(output, JSON.stringify(ledger.report(), null, 2) + '\n');
  } catch (err) {
    console.error(`E_IO: cannot write ${output}: ${err.message}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
