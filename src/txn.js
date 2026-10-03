export class TxnError extends Error {
  constructor(msg) { super(`transaction error: ${msg}`); this.name = 'TxnError'; }
}

// A single implicit transaction with nested savepoints over the model.
// add-job / move-job are undoable; commit finalizes everything.
export class TxnManager {
  constructor(model, onUndo) {
    this.model = model;
    this.onUndo = onUndo || (() => {});
    this.log = [];
    this.savepoints = [];
  }

  addJob(job) {
    this.model.addJob(job);
    this.log.push({ op: 'add', name: job.name });
  }

  moveJob(name, line) {
    const job = this.model.jobs.get(name);
    if (!job) throw new TxnError(`cannot move unknown job '${name}'`);
    this.log.push({ op: 'move', name, prev: job.line });
    job.line = line;
  }

  savepoint(name) {
    this.savepoints.push({ name, logLen: this.log.length });
  }

  rollback(name = null) {
    if (this.savepoints.length === 0) {
      if (name !== null) throw new TxnError(`no such savepoint '${name}'`);
      this.undoTo(0);
      return;
    }
    let idx;
    if (name === null) {
      idx = this.savepoints.length - 1;
    } else {
      idx = -1;
      for (let k = this.savepoints.length - 1; k >= 0; k--) {
        if (this.savepoints[k].name === name) { idx = k; break; }
      }
      if (idx < 0) throw new TxnError(`no such savepoint '${name}'`);
    }
    const sp = this.savepoints[idx];
    this.undoTo(sp.logLen);
    // Later savepoints are removed; the target and earlier ones stay valid.
    this.savepoints.length = idx + 1;
  }

  undoTo(logLen) {
    for (let k = this.log.length - 1; k >= logLen; k--) {
      const entry = this.log[k];
      if (entry.op === 'add') {
        this.model.jobs.delete(entry.name);
        this.onUndo({ op: 'add', name: entry.name });
      } else if (entry.op === 'move') {
        const job = this.model.jobs.get(entry.name);
        if (job) job.line = entry.prev;
        this.onUndo({ op: 'move', name: entry.name });
      }
    }
    this.log.length = logLen;
  }

  commit() {
    this.log = [];
    this.savepoints = [];
  }
}
