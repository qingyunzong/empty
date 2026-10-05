'use strict';

const { ProtocolError } = require('./errors');

const OPS = new Set(['PLAN', 'MOVE', 'CANCEL']);

// Validate and normalize a raw command. Throws ProtocolError on any violation.
function validateCommand(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProtocolError(`command must be an object, got ${JSON.stringify(raw)}`);
  }
  const { op, id, ver } = raw;
  if (!OPS.has(op)) throw new ProtocolError(`unknown op: ${JSON.stringify(op)}`);
  if (typeof id !== 'string' || id.length === 0) {
    throw new ProtocolError(`command ${op}: id must be a non-empty string`);
  }
  if (!Number.isInteger(ver) || ver < 1) {
    throw new ProtocolError(`command ${op} ${id}: ver must be an integer >= 1, got ${JSON.stringify(ver)}`);
  }
  const cmd = { op, id, ver };
  if (op === 'PLAN' || op === 'MOVE') {
    const { cost, start, end } = raw;
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new ProtocolError(`command ${op} ${id}: cost must be a finite number > 0, got ${JSON.stringify(cost)}`);
    }
    if (start !== undefined && !Number.isFinite(start)) {
      throw new ProtocolError(`command ${op} ${id}: start must be a finite number`);
    }
    if (end !== undefined && end !== null && !Number.isFinite(end)) {
      throw new ProtocolError(`command ${op} ${id}: end must be a finite number or null`);
    }
    cmd.cost = cost;
    cmd.start = start === undefined ? 0 : start;
    cmd.end = end === undefined ? null : end;
  }
  return cmd;
}

// Two normalized commands for the same id@ver must carry identical payloads.
function samePayload(a, b) {
  return a.op === b.op && a.cost === b.cost && a.start === b.start && a.end === b.end;
}

module.exports = { validateCommand, samePayload };
