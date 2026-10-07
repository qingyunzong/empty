'use strict';

class RecallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecallError';
    this.code = code;
  }
}

const E_EPOCH = 'E_EPOCH';
const E_DUP = 'E_DUP';
const E_PROOF = 'E_PROOF';

module.exports = { RecallError, E_EPOCH, E_DUP, E_PROOF };
