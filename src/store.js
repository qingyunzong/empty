'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function hashEntry(prevHash, entry) {
  return crypto.createHash('sha256').update(prevHash + '\n' + stableStringify(entry)).digest('hex');
}

function journalPath(dir) {
  return path.join(dir, 'journal.log');
}

// Reads raw lines; does not throw on corrupt lines.
function readRawLines(dir) {
  const p = journalPath(dir);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

class JournalCorruptError extends Error {
  constructor(index) {
    super(`journal corrupt at line ${index + 1}; run 'verify' to recover`);
    this.index = index;
  }
}

// Validates the hash chain. Returns { good: number of valid records, records,
// corrupt: boolean }. Only a valid prefix is returned.
function checkChain(dir) {
  const lines = readRawLines(dir);
  const records = [];
  let prev = GENESIS;
  let good = 0;
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      break;
    }
    if (!rec || typeof rec !== 'object' || !rec.entry) break;
    const expected = hashEntry(prev, rec.entry);
    if (rec.hash !== expected || rec.prevHash !== prev || rec.entry.seq !== i + 1) break;
    records.push(rec);
    prev = rec.hash;
    good++;
  }
  return { good, records, corrupt: good !== lines.length, total: lines.length };
}

function readJournal(dir) {
  const { records, corrupt, good } = checkChain(dir);
  if (corrupt) throw new JournalCorruptError(good);
  return records;
}

function appendEntry(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const records = readJournal(dir);
  const prevHash = records.length ? records[records.length - 1].hash : GENESIS;
  const full = { ...entry, seq: records.length + 1 };
  const hash = hashEntry(prevHash, full);
  fs.appendFileSync(journalPath(dir), JSON.stringify({ prevHash, hash, entry: full }) + '\n');
  return { seq: full.seq, hash };
}

// Truncates the journal to `count` records, keeping the chain valid.
function truncateJournal(dir, count) {
  const lines = readRawLines(dir).slice(0, count);
  fs.writeFileSync(journalPath(dir), lines.length ? lines.join('\n') + '\n' : '');
}

// verify: rejects a half-written / tampered tail and recovers by truncating
// to the last valid record. Returns { ok, removed }.
function verify(dir) {
  const { corrupt, good, total } = checkChain(dir);
  if (!corrupt) return { ok: true, entries: total, removed: 0 };
  truncateJournal(dir, good);
  return { ok: false, entries: good, removed: total - good };
}

// Deterministic replay of the journal into scheduler state.
function replay(records) {
  const state = {
    config: { setup: 0, maxRate: 1_000_000_000 },
    tasks: {},
    passes: {},
    lastSchedule: null,
  };
  for (const r of records) {
    const e = r.entry;
    switch (e.cmd) {
      case 'config':
        Object.assign(state.config, e.config);
        break;
      case 'pass_add':
        state.tasks[e.task.id] = { ...(state.tasks[e.task.id] || {}), ...e.task };
        state.passes[e.pass.id] = {
          ...e.pass,
          window: { start: e.pass.start, end: e.pass.end },
          drop: null,
          confirmed: null,
        };
        break;
      case 'correct': {
        const p = state.passes[e.passId];
        if (p) {
          p.window = { start: e.start, end: e.end };
          p.correctionPending = !!e.pending;
        }
        break;
      }
      case 'drop': {
        const p = state.passes[e.passId];
        if (p) p.drop = { reason: e.reason, pending: !!e.pending };
        break;
      }
      case 'confirm': {
        const p = state.passes[e.passId];
        if (p) p.confirmed = { start: e.start, txLen: e.txLen, bytes: e.bytes };
        break;
      }
      case 'schedule':
        state.lastSchedule = e.result;
        break;
      case 'undo':
        break;
    }
  }
  return state;
}

module.exports = {
  GENESIS,
  stableStringify,
  hashEntry,
  journalPath,
  readRawLines,
  readJournal,
  appendEntry,
  truncateJournal,
  verify,
  replay,
  JournalCorruptError,
};
