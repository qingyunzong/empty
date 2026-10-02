#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runPipeline } from './src/run.js';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const [, , ticksPath, accountsPath] = process.argv;
if (!ticksPath || !accountsPath) {
  fail('usage: node cli.js <ticks.json> <accounts.json>');
}

let ticksDoc;
let accountsDoc;
try {
  ticksDoc = JSON.parse(readFileSync(ticksPath, 'utf8'));
  accountsDoc = JSON.parse(readFileSync(accountsPath, 'utf8'));
} catch (err) {
  fail(`cannot read input: ${err.message}`);
}

let result;
try {
  result = runPipeline({ ticksDoc, accountsDoc });
} catch (err) {
  fail(err.message);
}

console.log(JSON.stringify(result, null, 2));
if (!result.proof.fullRecomputeMatch) process.exit(2);
