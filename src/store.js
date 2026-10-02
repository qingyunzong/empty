import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class CommitError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CommitError';
  }
}

export function loadState(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Atomic state commit: write a temp file in the same directory, fsync it,
 * then rename over the target. If anything fails before the rename (or the
 * caller injects a failure via failBeforeRename), the temp file is removed,
 * the original file is left byte-identical, and a CommitError is thrown so
 * the caller can roll back its in-memory allocation.
 */
export function commitState(state, path, { failBeforeRename = false } = {}) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const data = `${JSON.stringify(state, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new CommitError(`failed to write temp state file: ${err.message}`, { cause: err });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  if (failBeforeRename) {
    rmSync(tmp, { force: true });
    throw new CommitError('injected failure before rename (--fail-before-rename)');
  }

  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new CommitError(`failed to rename state file: ${err.message}`, { cause: err });
  }

  try {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort (unsupported on some platforms).
  }
}
