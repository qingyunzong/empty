'use strict';

class DeltaError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DeltaError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const make = (code) => (message, details) => new DeltaError(code, message, details);

const errPath = make('ERR_PATH');
const errGap = make('ERR_GAP');
const errHash = make('ERR_HASH');
const errState = make('ERR_STATE');

function toErrorJSON(err) {
  if (err instanceof DeltaError) {
    const out = { error: err.code, message: err.message };
    if (err.details !== undefined) out.details = err.details;
    return out;
  }
  return { error: 'ERR_INTERNAL', message: String((err && err.message) || err) };
}

module.exports = { DeltaError, errPath, errGap, errHash, errState, toErrorJSON };
