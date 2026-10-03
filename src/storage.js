'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOG_FILE = 'events.log';
const STATE_FILE = 'state.json';
const CORRECTIONS_FILE = 'corrections.log';

function paths(dir) {
  return {
    log: path.join(dir, LOG_FILE),
    state: path.join(dir, STATE_FILE),
    corrections: path.join(dir, CORRECTIONS_FILE),
  };
}

// Append one batch as a single JSON line and fsync. This is the atomic
// commit point: a crash before this call leaves no trace of the batch.
function appendBatch(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(paths(dir).log, 'a');
  try {
    fs.writeSync(fd, JSON.stringify({ batch: events }) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Replay the whole log, deduplicating events by id (first occurrence wins).
function replay(dir) {
  const p = paths(dir).log;
  if (!fs.existsSync(p)) return [];
  const out = [];
  const seen = new Set();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    for (const ev of rec.batch) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      out.push(ev);
    }
  }
  return out;
}

function loadState(dir) {
  const p = paths(dir).state;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = paths(dir).state + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, paths(dir).state);
}

function appendCorrections(dir, corrections) {
  if (!corrections.length) return;
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(paths(dir).corrections, 'a');
  try {
    for (const c of corrections) fs.writeSync(fd, JSON.stringify(c) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Rewrite the log as a single sorted, deduplicated batch (atomic rename).
function compact(dir) {
  const p = paths(dir).log;
  let batchesBefore = 0;
  let eventsBefore = 0;
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      batchesBefore += 1;
      eventsBefore += JSON.parse(line).batch.length;
    }
  }
  const events = replay(dir).sort((a, b) => {
    if (a.device !== b.device) return a.device < b.device ? -1 : 1;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ batch: events }) + '\n');
  fs.renameSync(tmp, p);
  return { batchesBefore, eventsBefore, eventsAfter: events.length };
}

module.exports = { appendBatch, replay, loadState, saveState, appendCorrections, compact };
