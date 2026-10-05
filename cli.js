#!/usr/bin/env node
import fs from 'node:fs';
import { Ledger, RefundError } from './src/ledger.js';
import { loadEvents, appendEvent } from './src/store.js';

function execute(ledger, command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new RefundError('VALIDATION_ERROR', 'each command must be a JSON object');
  }
  switch (command.op) {
    case 'payment':
      return ledger.addPayment(command);
    case 'refund':
      return ledger.requestRefund(command);
    case 'register':
      return ledger.registerRefund(command);
    case 'cancel':
      return ledger.cancelRefund(command);
    case 'snapshot':
      return { result: ledger.snapshot(), event: null };
    default:
      throw new RefundError('UNKNOWN_OP', `unknown op: ${String(command.op)}`);
  }
}

function toErrorPayload(err) {
  if (err instanceof RefundError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'INTERNAL_ERROR', message: String((err && err.message) || err) };
}

function main() {
  const historyFile = process.argv[2];
  if (!historyFile) {
    process.stdout.write(`${JSON.stringify({ error: { code: 'USAGE', message: 'usage: node cli.js <history.jsonl> [command-json]' } })}\n`);
    process.exitCode = 1;
    return;
  }

  let raw;
  try {
    raw = process.argv[3] !== undefined ? process.argv[3] : fs.readFileSync(0, 'utf8');
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: toErrorPayload(err) })}\n`);
    process.exitCode = 1;
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(`${JSON.stringify({ error: { code: 'INVALID_JSON', message: 'input is not valid JSON' } })}\n`);
    process.exitCode = 1;
    return;
  }

  let ledger;
  try {
    ledger = Ledger.replay(loadEvents(historyFile));
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: toErrorPayload(err) })}\n`);
    process.exitCode = 1;
    return;
  }

  const isBatch = Array.isArray(input);
  const commands = isBatch ? input : [input];
  const results = [];
  try {
    for (const command of commands) {
      const { result, event } = execute(ledger, command);
      if (event) {
        appendEvent(historyFile, event);
      }
      results.push(result);
    }
  } catch (err) {
    const payload = isBatch ? { results, error: toErrorPayload(err) } : { error: toErrorPayload(err) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const payload = isBatch ? { results } : results[0];
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main();
