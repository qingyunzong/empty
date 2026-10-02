'use strict';

const fs = require('node:fs');

class PersistError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PersistError';
    if (cause) this.cause = cause;
  }
}

function loadState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Atomically persist `state` to `file`: write a temp file, fsync, then
 * rename over the target. If anything fails before the rename (including
 * the injected `failBeforeRename` crash point), the original file is left
 * untouched and the temp file is removed.
 */
function saveStateAtomic(file, state, options = {}) {
  const tmp = `${file}.tmp-${process.pid}`;
  const data = JSON.stringify(state, null, 2) + '\n';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new PersistError(`failed writing temp state file: ${err.message}`, err);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  if (options.failBeforeRename) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new PersistError('simulated crash before rename (--fail-before-rename)');
  }

  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new PersistError(`failed renaming state file: ${err.message}`, err);
  }
}

module.exports = { loadState, saveStateAtomic, PersistError };
