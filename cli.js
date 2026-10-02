#!/usr/bin/env node
import {readFileSync, writeFileSync, writeSync} from 'node:fs';
import {Ledger, ChargebackError, applyOp} from './lib.js';

function fail(message) {
  writeSync(2, `E_INPUT: ${message}\n`);
  process.exit(1);
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  fail('usage: node cli.js <case.jsonl> <result.json>');
}

let text;
try {
  text = readFileSync(input, 'utf8');
} catch (err) {
  fail(`cannot read ${input}: ${err.message}`);
}

const ledger = new Ledger();
const results = [];
const lines = text.split(/\r?\n/);
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i].trim();
  if (line === '') continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    fail(`line ${i + 1}: invalid JSON`);
  }
  try {
    results.push(applyOp(ledger, obj));
  } catch (err) {
    if (err instanceof ChargebackError) fail(`line ${i + 1}: ${err.message}`);
    throw err;
  }
}

const report = {results, balances: ledger.balances(), audit: ledger.audit};
try {
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
} catch (err) {
  fail(`cannot write ${output}: ${err.message}`);
}
