#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { PaymentNetwork, NetError } = require('./lib/network');

const COMMANDS = {
  'add-edge': (net, cmd) => net.addEdge(cmd),
  'close-edge': (net, cmd) => net.closeEdge(cmd),
  'open-edge': (net, cmd) => net.openEdge(cmd),
  'cancel-batch': (net, cmd) => net.cancelBatch(cmd),
};

function handleLine(network, line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: 'INVALID_JSON', message: 'line is not valid JSON' } };
  }
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'command must be a JSON object' } };
  }
  const handler = COMMANDS[command.type];
  if (!handler) {
    return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `unknown command type "${command.type}"` } };
  }
  try {
    const result = handler(network, command);
    return { ok: true, type: command.type, ...result };
  } catch (err) {
    if (err instanceof NetError) {
      const error = { code: err.code, message: err.message };
      if (err.details !== undefined) error.details = err.details;
      const response = { ok: false, type: command.type, error };
      if (err.bridgeCertificate) response.bridgeCertificate = err.bridgeCertificate;
      return response;
    }
    throw err;
  }
}

// Pure NDJSON-in / NDJSON-out session, used by both the CLI and tests.
function runSession(input) {
  const network = new PaymentNetwork();
  const output = [];
  for (const line of input.split('\n')) {
    if (line.trim() === '') continue;
    output.push(JSON.stringify(handleLine(network, line)));
  }
  return output.join('\n') + (output.length > 0 ? '\n' : '');
}

async function main() {
  const network = new PaymentNetwork();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    process.stdout.write(JSON.stringify(handleLine(network, line)) + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { handleLine, runSession };
