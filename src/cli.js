#!/usr/bin/env node
import readline from 'node:readline';
import { NetworkError, PaymentNetwork } from './network.js';

const network = new PaymentNetwork();

function handle(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new NetworkError('BAD_REQUEST', 'each line must be a JSON object');
  }
  switch (message.cmd) {
    case 'add-edge': {
      const edge = network.addEdge(message.a, message.b, message.bandwidth ?? 1);
      return { ok: true, edge };
    }
    case 'close-edge': {
      const result = network.closeEdge(message.a, message.b);
      return { ok: true, ...result };
    }
    case 'open-edge': {
      const edge = network.openEdge(message.a, message.b);
      return { ok: true, edge };
    }
    case 'cancel-batch': {
      const result = network.cancelBatch(message.payments);
      return { ok: true, ...result };
    }
    case 'snapshot': {
      return { ok: true, ...network.snapshot() };
    }
    default:
      throw new NetworkError('UNKNOWN_COMMAND', `unknown command: ${JSON.stringify(message.cmd)}`);
  }
}

const reader = readline.createInterface({ input: process.stdin, terminal: false });

for await (const line of reader) {
  const trimmed = line.trim();
  if (trimmed === '') continue;
  let response;
  try {
    response = handle(JSON.parse(trimmed));
  } catch (error) {
    if (error instanceof NetworkError) {
      response = { ok: false, error: { code: error.code, message: error.message } };
      if (error.details !== undefined) response.error.details = error.details;
    } else {
      response = { ok: false, error: { code: 'BAD_REQUEST', message: String(error?.message ?? error) } };
    }
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
