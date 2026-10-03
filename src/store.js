'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256, canonical } = require('./hash');
const { createEmptyState, applyEvent, computeStateRoot, ValidationError } = require('./core');

const GENESIS_HASH = sha256('evidence-journal-genesis');

class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptionError'; // exit code 3
  }
}

function eventHashOf(prevHash, entry) {
  return sha256(prevHash + canonical({
    seq: entry.seq, lamport: entry.lamport, now: entry.now == null ? null : entry.now,
    type: entry.type, payload: entry.payload,
  }));
}

// Drop undefined fields so hashing matches the serialized form.
function sanitize(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.journalPath = path.join(dir, 'journal.jsonl');
    this.snapPath = path.join(dir, 'state.json');
  }

  exists() {
    return fs.existsSync(this.journalPath);
  }

  // Returns { events, validPrefix, corrupt } where events are the parsed valid
  // prefix of the journal and corrupt indicates truncation/corruption after it.
  readJournal() {
    const events = [];
    if (!fs.existsSync(this.journalPath)) return { events, corrupt: false };
    const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter((l) => l.length > 0);
    let prev = GENESIS_HASH;
    let corrupt = false;
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        corrupt = true;
        break;
      }
      if (eventHashOf(prev, entry) !== entry.eventHash || entry.prevEventHash !== prev) {
        corrupt = true;
        break;
      }
      events.push(entry);
      prev = entry.eventHash;
    }
    return { events, corrupt };
  }

  appendEvent(event) {
    const { events } = this.readJournal();
    const prev = events.length ? events[events.length - 1].eventHash : GENESIS_HASH;
    const entry = {
      seq: events.length + 1,
      lamport: event.lamport || 0,
      now: event.now == null ? null : event.now,
      type: event.type,
      payload: sanitize(event.payload || {}),
    };
    entry.prevEventHash = prev;
    entry.eventHash = eventHashOf(prev, entry);
    fs.mkdirSync(this.dir, { recursive: true });
    const fd = fs.openSync(this.journalPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return entry;
  }

  truncateJournal(keepEvents) {
    const fd = fs.openSync(this.journalPath, 'w');
    try {
      for (const entry of keepEvents) fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  writeSnapshot(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    const snap = { seq: state.seq, stateRoot: computeStateRoot(state), state };
    const tmp = this.snapPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, this.snapPath);
    return snap;
  }

  readSnapshot() {
    if (!fs.existsSync(this.snapPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.snapPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // Replay events from genesis. The journal is the source of truth; the
  // snapshot is only a cache. Throws CorruptionError on journal corruption.
  replay(events) {
    const state = createEmptyState();
    for (const entry of events) {
      try {
        applyEvent(state, { type: entry.type, lamport: entry.lamport, now: entry.now, payload: entry.payload });
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new CorruptionError(`journal event #${entry.seq} fails validation: ${err.message}`);
        }
        throw err;
      }
    }
    return state;
  }

  lastEventsHash(events) {
    return events.length ? events[events.length - 1].eventHash : GENESIS_HASH;
  }

  // Load a consistent state for normal commands. Refuses to proceed on a
  // corrupt journal (run `audit` to repair).
  load() {
    const { events, corrupt } = this.readJournal();
    if (corrupt) throw new CorruptionError('journal corrupt; run `audit` to repair');
    return { state: this.replay(events), events };
  }

  // Audit: detect and repair divergence between journal and snapshot at crash
  // points (before/after the state write). Always ends consistent.
  audit() {
    const report = { journalEvents: 0, journalCorrupt: false, snapshot: 'ok', actions: [] };
    let { events, corrupt } = this.readJournal();
    if (corrupt) {
      report.journalCorrupt = true;
      this.truncateJournal(events);
      report.actions.push(`truncated journal to ${events.length} valid events`);
    }
    report.journalEvents = events.length;
    const state = this.replay(events);
    const stateRoot = computeStateRoot(state);
    const snap = this.readSnapshot();
    if (!snap) {
      report.snapshot = events.length ? 'rebuilt' : 'ok';
      if (events.length) report.actions.push('snapshot missing; rebuilt from journal');
    } else if (snap.seq < events.length) {
      report.snapshot = 'replayed-forward';
      report.actions.push(
        `crash before state write: snapshot at seq ${snap.seq}, replayed ${events.length - snap.seq} event(s)`,
      );
    } else if (snap.seq > events.length) {
      report.snapshot = 'rolled-back';
      report.actions.push(
        `crash after state write: snapshot at seq ${snap.seq} beyond journal (${events.length}); rebuilt from journal`,
      );
    } else if (snap.stateRoot !== stateRoot) {
      report.snapshot = 'root-mismatch';
      report.actions.push('snapshot state root mismatch; rebuilt from journal');
    }
    if (report.snapshot !== 'ok' || corrupt || (!snap && events.length)) {
      this.writeSnapshot(state);
    }
    return {
      report,
      state,
      digest: {
        rulesVersion: state.rulesVersion,
        seq: state.seq,
        eventsHash: this.lastEventsHash(events),
        stateRoot,
      },
    };
  }
}

module.exports = { Store, CorruptionError, GENESIS_HASH };
