'use strict';

const CODES = Object.freeze({
  SEALED: 'SEALED',
  CONFLICT_DOMAIN: 'CONFLICT_DOMAIN',
  NO_SLOT: 'NO_SLOT',
  BAD_DIFF: 'BAD_DIFF',
});

class ReconcileError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReconcileError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const sealed = (msg, details) => new ReconcileError(CODES.SEALED, msg, details);
const conflictDomain = (msg, details) => new ReconcileError(CODES.CONFLICT_DOMAIN, msg, details);
const noSlot = (msg, details) => new ReconcileError(CODES.NO_SLOT, msg, details);
const badDiff = (msg, details) => new ReconcileError(CODES.BAD_DIFF, msg, details);

module.exports = { CODES, ReconcileError, sealed, conflictDomain, noSlot, badDiff };
