#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { CreditNetwork, CreditNetworkError } = require('./src/credit-network');

async function main() {
  const network = new CreditNetwork();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let hadError = false;
  let lineNo = 0;

  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let command;
    try {
      command = JSON.parse(trimmed);
    } catch {
      hadError = true;
      process.stdout.write(
        JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: `line ${lineNo}: not valid JSON` } }) + '\n'
      );
      continue;
    }

    try {
      const result = network.execute(command);
      // Insufficient capacity is a business-level rejection, not a hard error.
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err) {
      hadError = true;
      if (err instanceof CreditNetworkError) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }) + '\n');
      } else {
        process.stdout.write(
          JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: String(err && err.message) } }) + '\n'
        );
      }
    }
  }

  process.exitCode = hadError ? 1 : 0;
}

main();
