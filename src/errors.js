'use strict';

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const E_WINDOW = 'E_WINDOW';
const E_MERGE = 'E_MERGE';
const E_RETAIN = 'E_RETAIN';

module.exports = { ArchiveError, E_WINDOW, E_MERGE, E_RETAIN };
