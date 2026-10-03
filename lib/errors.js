'use strict';

const ERR = {
  CYCLE: 20,
  ORPHAN_RECEIPT: 21,
  BUDGET_EXCEEDED: 22,
};

class ReconError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
  }
}

module.exports = { ERR, ReconError };
