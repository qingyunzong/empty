'use strict';
// Persistence: append-only events.jsonl is the source of truth.
// index.json (queue index cache) is derived; a torn or stale index is rebuilt
// deterministically from the log on restart.

const fs = require('node:fs');
const path = require('node:path');
const { createState, applyEvent, computeBucket, proofReport, canon, sha256 } = require('./engine');

const LOG = 'events.jsonl';
const INDEX = 'index.json';

function loadState(dir) {
  const state = createState();
  const file = path.join(dir, LOG);
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) applyEvent(state, JSON.parse(line));
  }
  return state;
}

function appendEvents(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  const data = events.map((ev) => canon(ev)).join('\n') + '\n';
  fs.appendFileSync(path.join(dir, LOG), data);
}

// Build the derived queue index: bucket coverage for every (ccy|date) bucket
// touched by trades or liquidity, plus the proof head for integrity checking.
function buildIndex(state) {
  const keys = new Set(state.liquidity.keys());
  for (const t of state.trades.values()) {
    if (t.amount - t.cancelled <= 0) continue;
    const date = require('./engine').adjust(t.valueDate, state.calendar);
    const [base, quote] = t.pair.split('/');
    keys.add(base + '|' + date);
    keys.add(quote + '|' + date);
  }
  const buckets = {};
  for (const k of [...keys].sort()) {
    buckets[k] = Object.fromEntries(computeBucket(state, k));
  }
  const proof = proofReport(state);
  const body = { events: proof.events, head: proof.head, buckets };
  return { ...body, indexHash: sha256(canon(body)) };
}

function saveIndex(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, INDEX), JSON.stringify(buildIndex(state)));
}

// Returns { ok, reason }. Never throws on corrupt/missing index: caller rebuilds.
function checkIndex(dir, state) {
  const file = path.join(dir, INDEX);
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'torn' };
  }
  if (!idx || typeof idx !== 'object' || typeof idx.indexHash !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const { indexHash, ...body } = idx;
  if (sha256(canon(body)) !== indexHash) return { ok: false, reason: 'hash-mismatch' };
  const proof = proofReport(state);
  if (idx.head !== proof.head || idx.events !== proof.events) return { ok: false, reason: 'stale' };
  return { ok: true };
}

module.exports = { loadState, appendEvents, saveIndex, checkIndex, buildIndex, LOG, INDEX };
