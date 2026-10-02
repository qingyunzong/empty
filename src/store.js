'use strict';

const fs = require('node:fs');
const path = require('node:path');

// JSON file store with atomic commit protocol:
//   1. serialize full state to `<file>.tmp`
//   2. rename tmp over the state file (atomic on POSIX)
// A commit is only successful once rename completes. Fault-injection hooks
// (beforeTmpWrite / beforeRename / afterRename) let tests simulate a crash
// at the explicit fault point just before the state file is replaced; on
// failure the previous state file remains untouched and readable.
class Store {
  constructor(filePath, hooks = {}) {
    this.path = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.hooks = hooks;
  }

  exists() {
    return fs.existsSync(this.path);
  }

  load() {
    if (!this.exists()) return null;
    return JSON.parse(fs.readFileSync(this.path, 'utf8'));
  }

  commit(state) {
    if (this.hooks.beforeTmpWrite) this.hooks.beforeTmpWrite(state);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.tmpPath, JSON.stringify(state, null, 2));
    // explicit fault point: crash here = crash before state file is written
    if (this.hooks.beforeRename) this.hooks.beforeRename(state);
    fs.renameSync(this.tmpPath, this.path);
    if (this.hooks.afterRename) this.hooks.afterRename(state);
  }
}

module.exports = { Store };
