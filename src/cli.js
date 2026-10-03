#!/usr/bin/env node
import readline from 'node:readline';
import { Ledger, LedgerError } from './ledger.js';

const ledger = new Ledger();
let hadError = false;
let lineNo = 0;

function handle(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new LedgerError('INVALID_MESSAGE', 'each line must be a JSON object');
  }
  switch (msg.op) {
    case 'add-dep':
      return ledger.addDep(msg.from, msg.to);
    case 'remove-dep':
      return ledger.removeDep(msg.from, msg.to);
    case 'cancel':
      return ledger.cancel(msg.tx, msg.event);
    case 'restore':
      return ledger.restore(msg.tx, msg.event);
    default:
      throw new LedgerError('UNKNOWN_OP', `unknown op ${JSON.stringify(msg.op)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  lineNo += 1;
  const trimmed = line.trim();
  if (trimmed === '') continue;
  let result;
  try {
    result = handle(JSON.parse(trimmed));
  } catch (err) {
    hadError = true;
    result = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err && err.code ? err.code : 'ERROR',
      line: lineNo,
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (hadError) process.exitCode = 1;
