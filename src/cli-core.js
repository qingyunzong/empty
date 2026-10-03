'use strict';

const { Ledger, LedgerError, MUTATION_OPS } = require('./ledger');

function handleCommand(ledger, command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new LedgerError('INVALID_COMMAND', 'each line must be a JSON object');
  }
  const { op } = command;
  if (MUTATION_OPS.has(op)) {
    ledger.applyEvent(command);
    return { id: command.id, op, ...ledger.evaluate() };
  }
  if (op === 'undo') {
    ledger.undo(command.id);
    return { id: command.id, op, ...ledger.evaluate() };
  }
  if (op === 'redo') {
    ledger.redo(command.id);
    return { id: command.id, op, ...ledger.evaluate() };
  }
  if (op === 'check') {
    return { op, ...ledger.evaluate() };
  }
  throw new LedgerError('UNKNOWN_OP', `unknown op: ${String(op)}`);
}

// Drive the command loop over an iterable of raw NDJSON lines.
// emit receives one result object per processed line.
// Returns the process exit code: 0 on success, 1 on the first error
// (processing stops at that error).
async function runLines(lines, emit) {
  const ledger = new Ledger();
  for await (const raw of lines) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    let command;
    try {
      command = JSON.parse(trimmed);
    } catch {
      emit({ ok: false, error: { code: 'PARSE_ERROR', message: 'line is not valid JSON' } });
      return 1;
    }
    try {
      emit({ ok: true, ...handleCommand(ledger, command) });
    } catch (err) {
      if (err instanceof LedgerError) {
        emit({ ok: false, id: command.id, op: command.op, error: { code: err.code, message: err.message } });
        return 1;
      }
      throw err;
    }
  }
  return 0;
}

module.exports = { runLines, handleCommand };
