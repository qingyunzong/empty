'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, canonicalHash } = require('./util');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return {
    seq: 0,
    packs: {},
    certs: {},
    quotas: {},
    revoked: [],
    superseded: [],
    wal: [],
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.stateFile = path.join(dir, 'state.json');
    this.journalFile = path.join(dir, 'journal.log');
    fs.mkdirSync(dir, { recursive: true });
    this._load();
  }

  _load() {
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!state) state = emptyState();
    this.state = state;
    this.journal = [];
    try {
      const lines = fs.readFileSync(this.journalFile, 'utf8').split('\n');
      for (const line of lines) {
        if (line.trim()) this.journal.push(JSON.parse(line));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  begin(command, payload) {
    const record = {
      seq: this.state.seq + 1,
      command,
      payload: clone(payload),
      phase: 'begin',
      ts: new Date().toISOString(),
    };
    fs.appendFileSync(this.journalFile, JSON.stringify(record) + '\n');
    this.journal.push(record);
    return record;
  }

  commit(record, state) {
    state.seq = record.seq;
    state.wal.push({
      seq: record.seq,
      command: record.command,
      payload: clone(record.payload),
      hash: canonicalHash({ seq: record.seq, command: record.command, payload: record.payload }),
    });
    this.state = state;
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, canonicalize(state));
    fs.renameSync(tmp, this.stateFile);
    const done = { seq: record.seq, command: record.command, phase: 'commit', ts: new Date().toISOString() };
    fs.appendFileSync(this.journalFile, JSON.stringify(done) + '\n');
    this.journal.push(done);
  }

  fail(record, error) {
    const rec = { seq: record.seq, command: record.command, phase: 'fail', error: String(error && error.message || error), ts: new Date().toISOString() };
    fs.appendFileSync(this.journalFile, JSON.stringify(rec) + '\n');
    this.journal.push(rec);
  }

  recover() {
    const last = this.journal[this.journal.length - 1];
    if (!last) return { recovered: false, reason: 'empty-journal' };
    if (last.phase === 'commit' || last.phase === 'fail') return { recovered: false, reason: 'clean' };
    const rec = { seq: last.seq, command: last.command, phase: 'rollback', ts: new Date().toISOString() };
    fs.appendFileSync(this.journalFile, JSON.stringify(rec) + '\n');
    this.journal.push(rec);
    return { recovered: true, rolledBackSeq: last.seq, command: last.command };
  }

  stateRoot() {
    const s = this.state;
    return canonicalHash({
      packs: s.packs,
      certs: s.certs,
      quotas: s.quotas,
      revoked: s.revoked,
      superseded: s.superseded,
      seq: s.seq,
    });
  }

  inputEventsHash() {
    return canonicalHash(this.state.wal);
  }
}

module.exports = { Store, emptyState, clone };
