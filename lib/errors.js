'use strict';

const ERR_READ_ONLY_TARGET = 60;
const ERR_TOMBSTONE_RESURRECTION = 61;

class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.details = details || {};
  }
}

module.exports = { SyncError, ERR_READ_ONLY_TARGET, ERR_TOMBSTONE_RESURRECTION };
