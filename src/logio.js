'use strict';
// JSONL event-log IO, crash-safe compaction, and recovery.
//
// Compact failure points and guarantees:
//   1. write <log>.tmp   2. fsync(tmp)   3. rename(tmp -> log)   4. fsync(dir)
// A crash at any point leaves recover() with exactly one of two outcomes:
// the old complete log, or the new complete log. rename(2) is atomic on POSIX,
// so a torn log is impossible; a leftover .tmp is either complete (install it)
// or partial (discard it, keep the old log).

const fs = require('node:fs');
const path = require('node:path');
const { foldEvents, snapshotOf } = require('./state');

const SENTINEL = JSON.stringify({ type: 'end' });

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf8');
  return text.split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((ev) => ev.type !== 'end'); // on-disk commit sentinel, not an event
}

function appendEvent(logPath, event) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Atomic replace: tmp + fsync + rename + dir fsync.
function atomicWrite(logPath, lines) {
  const tmp = logPath + '.tmp';
  const payload = lines.join('\n') + '\n' + SENTINEL + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, logPath);
  const dfd = fs.openSync(path.dirname(logPath), 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

function isCompleteTmp(tmpPath) {
  try {
    const text = fs.readFileSync(tmpPath, 'utf8');
    if (!text.endsWith(SENTINEL + '\n')) return false;
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    lines.forEach((l) => JSON.parse(l)); // throws on a torn line
    return true;
  } catch {
    return false;
  }
}

// Reconcile a leftover .tmp after a crash. Returns 'old' | 'new' | 'clean'.
function recover(logPath) {
  const tmp = logPath + '.tmp';
  if (!fs.existsSync(tmp)) return 'clean';
  if (isCompleteTmp(tmp)) {
    // Crash after fsync(tmp) but before/around rename: install the new log.
    fs.renameSync(tmp, logPath);
    const dfd = fs.openSync(path.dirname(logPath), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    return 'new';
  }
  // Partial tmp: discard it; the old log (if any) is the complete one.
  fs.unlinkSync(tmp);
  return 'old';
}

// Fold the current log into a single snapshot event and atomically replace the
// log. verify() is a pure function of folded state, so results are unchanged.
function compact(logPath) {
  recover(logPath); // reconcile any leftover from a previous crashed compact
  const events = readLog(logPath);
  const state = foldEvents(events);
  const snapshot = { type: 'snapshot', state: snapshotOf(state) };
  atomicWrite(logPath, [JSON.stringify(snapshot)]);
  return { before: events.length, after: 1 };
}

module.exports = { readLog, appendEvent, atomicWrite, recover, compact, isCompleteTmp, SENTINEL };
