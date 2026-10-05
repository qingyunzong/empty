'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { state: stateErr } = require('./errors.js');

// On-disk layout under <dir>:
//   state.json(.tmp)   ledger: {nodeId, vv, inventory, ops, pending, closedSessions}
//   cursor.json(.tmp)  {offset} processed byte offset into scan.log
//   scan.log           JSONL change-capture log (scan/adjust events)
//   sessions/<id>.json(.tmp)
class Store {
  constructor(dir, hooks = {}) {
    this.dir = dir;
    this.hooks = hooks;
  }

  get statePath() { return path.join(this.dir, 'state.json'); }
  get cursorPath() { return path.join(this.dir, 'cursor.json'); }
  get scanLogPath() { return path.join(this.dir, 'scan.log'); }
  get sessionsDir() { return path.join(this.dir, 'sessions'); }
  sessionPath(id) { return path.join(this.sessionsDir, `${id}.json`); }

  exists() { return fs.existsSync(this.statePath); }

  init(nodeId) {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    if (!fs.existsSync(this.statePath)) {
      this.saveState({ nodeId, vv: {}, inventory: {}, ops: [], pending: [], closedSessions: [] });
    }
    if (!fs.existsSync(this.scanLogPath)) fs.writeFileSync(this.scanLogPath, '');
    if (!fs.existsSync(this.cursorPath)) this.saveCursor({ offset: 0 });
  }

  requireInit() {
    if (!this.exists()) {
      throw stateErr('NOT_INITIALIZED', `no wip-count data at ${this.dir} (run "init --node <id>" first)`);
    }
  }

  loadState() {
    this.requireInit();
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
  }

  saveState(state) {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    this.hooks.beforeLedgerCommit && this.hooks.beforeLedgerCommit();
    fs.renameSync(tmp, this.statePath); // ledger commit point
    this.hooks.afterLedgerCommit && this.hooks.afterLedgerCommit();
  }

  loadCursor() {
    if (!fs.existsSync(this.cursorPath)) return { offset: 0 };
    return JSON.parse(fs.readFileSync(this.cursorPath, 'utf8'));
  }

  saveCursor(cursor) {
    const tmp = this.cursorPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cursor));
    fs.renameSync(tmp, this.cursorPath);
  }

  // Returns the byte offset just past the appended line.
  appendEvent(ev) {
    fs.appendFileSync(this.scanLogPath, JSON.stringify(ev) + '\n');
    return fs.statSync(this.scanLogPath).size;
  }

  readEventsFrom(offset) {
    if (!fs.existsSync(this.scanLogPath)) return [];
    const buf = fs.readFileSync(this.scanLogPath);
    const slice = buf.subarray(offset).toString('utf8');
    const events = [];
    let pos = offset;
    for (const line of slice.split('\n')) {
      const end = pos + Buffer.byteLength(line) + 1;
      if (line) events.push({ ev: JSON.parse(line), endOffset: end });
      pos = end;
    }
    return events;
  }

  loadSession(id) {
    const p = this.sessionPath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  saveSession(sess) {
    const tmp = this.sessionPath(sess.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sess, null, 2));
    this.hooks.beforeSessionRename && this.hooks.beforeSessionRename();
    fs.renameSync(tmp, this.sessionPath(sess.id)); // session commit point
  }

  deleteSession(id) {
    const p = this.sessionPath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  listSessionFiles() {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs.readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  }

  // Crash recovery step 1: a *.tmp file means its rename never happened -> discard.
  cleanTmp() {
    const dirs = [this.dir, this.sessionsDir];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.tmp')) fs.unlinkSync(path.join(d, f));
      }
    }
  }
}

module.exports = { Store };
