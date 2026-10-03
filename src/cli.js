#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { runLines } = require('./cli-core');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exitCode = await runLines(rl, emit);
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(err) } })}\n`);
  process.exitCode = 1;
});
