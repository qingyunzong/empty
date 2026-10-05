#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs';
import { ClearingNetwork, ClearingError } from './ledger.js';

const network = new ClearingNetwork();

function writeLine(fd, value) {
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
  } catch (err) {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  }
}

function fail(payload, line) {
  const error = { code: payload.code, message: payload.message };
  if (line !== undefined) error.line = line;
  writeLine(2, { ok: false, error });
  process.exit(1);
}

function handle(cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new ClearingError('INVALID_COMMAND', 'each line must be a JSON object');
  }
  switch (cmd.op) {
    case 'add-edge':
      return { event: cmd.event, ...network.addEdge(cmd.event, cmd) };
    case 'update-edge':
      return { event: cmd.event, ...network.updateEdge(cmd.event, cmd.id, cmd) };
    case 'remove-edge':
      return { event: cmd.event, ...network.removeEdge(cmd.event, cmd.id) };
    case 'undo':
      return { undone: cmd.id, ...network.undo(cmd.id) };
    case 'redo':
      return { redone: cmd.id, ...network.redo(cmd.id) };
    case 'check':
      return network.status();
    case 'node-flow':
      return network.nodeFlow(cmd.id);
    default:
      throw new ClearingError('INVALID_COMMAND', `unknown op ${JSON.stringify(cmd.op)}`);
  }
}

let input;
try {
  input = readFileSync(0, 'utf8');
} catch (err) {
  fail({ code: 'READ_ERROR', message: `cannot read stdin: ${err.message}` });
}

let lineNumber = 0;
for (const line of input.split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '') continue;
  lineNumber += 1;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    fail({ code: 'INVALID_JSON', message: `line ${lineNumber} is not valid JSON` }, lineNumber);
  }
  try {
    const result = handle(cmd);
    writeLine(1, { ok: true, ...result });
  } catch (err) {
    if (err instanceof ClearingError) {
      fail({ code: err.code, message: err.message }, lineNumber);
    }
    throw err;
  }
}
