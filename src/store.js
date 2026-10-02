'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { rootHash } = require('./state');

// Crash-safe generation store.
// Layout: gen-<n>.json (immutable snapshots {root, state}), HEAD (committed
// generation number), working.json (current mutable state + dirty flag).
// Every write is tmp-file + fsync + atomic rename; HEAD is updated last, so
// a crash mid-commit leaves either the old or the new generation visible,
// never a torn one. Stray *.tmp files are ignored on recovery.
class Store {
  constructor(dir, hooks = {}) {
    this.dir = dir;
    this.hooks = hooks;
    fs.mkdirSync(dir, { recursive: true });
  }

  _hook(step) {
    if (this.hooks.onStep) this.hooks.onStep(step);
  }

  _headFile() {
    return path.join(this.dir, 'HEAD');
  }

  _workingFile() {
    return path.join(this.dir, 'working.json');
  }

  _genFile(gen) {
    return path.join(this.dir, `gen-${gen}.json`);
  }

  _writeTmp(file, data) {
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return tmp;
  }

  _writeAtomic(file, data) {
    fs.renameSync(this._writeTmp(file, data), file);
  }

  _readJson(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  _readHead() {
    try {
      const n = Number(fs.readFileSync(this._headFile(), 'utf8').trim());
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  saveWorking(state, dirty) {
    this._writeAtomic(this._workingFile(), JSON.stringify({ dirty, state }));
  }

  commit(state) {
    const gen = state.generation;
    const root = rootHash(state);
    this._hook('commit:start');
    const genTmp = this._writeTmp(this._genFile(gen), JSON.stringify({ root, state }));
    this._hook('commit:genTmpWritten');
    fs.renameSync(genTmp, this._genFile(gen));
    this._hook('commit:genRenamed');
    const headTmp = this._writeTmp(this._headFile(), String(gen));
    this._hook('commit:headTmpWritten');
    fs.renameSync(headTmp, this._headFile());
    this._hook('commit:headRenamed');
    this.saveWorking(state, false);
    this._hook('commit:workingWritten');
    return { generation: gen, root };
  }

  undo() {
    const head = this._readHead();
    if (head == null || head <= 0) return null;
    const rec = this._readJson(`gen-${head - 1}.json`);
    if (!rec || !rec.state || rootHash(rec.state) !== rec.root) return null;
    this._writeAtomic(this._headFile(), String(head - 1));
    this.saveWorking(rec.state, false);
    return rec.state;
  }

  recover() {
    const head = this._readHead();
    const working = this._readJson('working.json');
    if (head != null && working && working.state && working.state.generation === head) {
      return { state: working.state, dirty: !!working.dirty };
    }
    // Working file is missing or refers to an uncommitted generation
    // (crash between HEAD update and working write): fall back to the
    // committed snapshot, walking down if a generation file is damaged.
    if (head != null) {
      for (let g = head; g >= 0; g -= 1) {
        const rec = this._readJson(`gen-${g}.json`);
        if (rec && rec.state && rootHash(rec.state) === rec.root) {
          if (g !== head) this._writeAtomic(this._headFile(), String(g));
          return { state: rec.state, dirty: false };
        }
      }
    }
    if (working && working.state) return { state: working.state, dirty: !!working.dirty };
    return null;
  }
}

module.exports = { Store };
