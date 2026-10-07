'use strict';

const CODES = {
  TOKEN_UNKNOWN: 'TOKEN_UNKNOWN',
  RULE_CYCLE_UNSUPPORTED: 'RULE_CYCLE_UNSUPPORTED',
  APPLY_CONFLICT: 'APPLY_CONFLICT',
  UNDO_EMPTY: 'UNDO_EMPTY',
  RULE_PARSE: 'RULE_PARSE',
  FAULT_INJECTED: 'FAULT_INJECTED',
};

class RiskError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { CODES, RiskError };
