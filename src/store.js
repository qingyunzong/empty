'use strict';

const fs = require('fs');
const path = require('path');
const { createState, applyEvent } = require('./engine');

function layout(dir) {
  return {
    log: path.join(dir, 'events.jsonl'),
    snap: path.join(dir, 'snapshot.json'),
    reviewers: path.join(dir, 'reviewers.json'),
    config: path.join(dir, 'config.json'),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readEvents(dir) {
  const file = layout(dir).log;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events = [];
  const nonEmpty = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) nonEmpty.push(trimmed);
  }
  nonEmpty.forEach((line, idx) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      if (idx !== nonEmpty.length - 1) {
        throw new Error(`corrupt event log at record ${idx + 1}`);
      }
      // Tolerate a torn final record left by a crash mid-append.
    }
  });
  events.forEach((e, i) => {
    e.seq = i;
  });
  return events;
}

function sortEvents(events) {
  return [...events].sort(
    (a, b) =>
      a.time - b.time ||
      (a.caseId ? 0 : 1) - (b.caseId ? 0 : 1) ||
      String(a.source || '').localeCompare(String(b.source || '')) ||
      String(a.caseId || '￿').localeCompare(String(b.caseId || '￿')) ||
      a.seq - b.seq
  );
}

function loadReviewers(dir) {
  const data = readJson(layout(dir).reviewers, null);
  if (!data) {
    throw new Error(`missing reviewers file: ${layout(dir).reviewers}`);
  }
  return Array.isArray(data) ? data : data.reviewers || [];
}

function loadConfig(dir) {
  return readJson(layout(dir).config, {});
}

function recover(dir) {
  const events = readEvents(dir);
  const snap = readJson(layout(dir).snap, null);
  const state = snap ? snap.state : createState();
  const tail = events.slice(snap ? snap.eventCount : 0);
  for (const e of sortEvents(tail)) applyEvent(state, e);
  return {
    state,
    events,
    snapshot: snap,
    reviewers: loadReviewers(dir),
    config: loadConfig(dir),
  };
}

function recompute(dir) {
  const events = readEvents(dir);
  const state = createState();
  for (const e of sortEvents(events)) applyEvent(state, e);
  return state;
}

function appendEvent(dir, event) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(layout(dir).log, JSON.stringify(event) + '\n');
}

function writeSnapshot(dir, state, eventCount, time) {
  const snap = {
    kind: 'snapshot',
    createdAt: time ?? null,
    eventCount,
    certHash: state.certHash,
    state,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(layout(dir).snap, JSON.stringify(snap, null, 2) + '\n');
  return snap;
}

module.exports = {
  layout,
  readEvents,
  sortEvents,
  loadReviewers,
  loadConfig,
  recover,
  recompute,
  appendEvent,
  writeSnapshot,
};
