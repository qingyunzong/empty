import fs from 'node:fs';
import path from 'node:path';

// Persistent store: store.json holds committed state, wal.log holds
// PREPARE/COMMIT/ROLLBACK records. On load, any PREPARE without a matching
// COMMIT is rolled back (crash between PREPARE and COMMIT => uncommitted).
//
// Recovery only runs after an unclean shutdown: a clean exit writes a
// marker file that load() consumes. A process that dies mid-command (or the
// simulated `crash` command) leaves no marker, so the next start rolls back.
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.storeFile = path.join(dir, 'store.json');
    this.walFile = path.join(dir, 'wal.log');
    this.markerFile = path.join(dir, 'clean.shutdown');
    this.data = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.data = fs.existsSync(this.storeFile)
      ? JSON.parse(fs.readFileSync(this.storeFile, 'utf8'))
      : { rootId: null, txSeq: 0, groups: {} };
    const cleanShutdown = fs.existsSync(this.markerFile);
    fs.rmSync(this.markerFile, { force: true });
    if (fs.existsSync(this.walFile) && !cleanShutdown) this.recover();
    return this.data;
  }

  markCleanShutdown() {
    fs.writeFileSync(this.markerFile, 'ok\n');
  }

  save() {
    const tmp = `${this.storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.storeFile);
  }

  appendWal(record) {
    const fd = fs.openSync(this.walFile, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  recover() {
    if (!fs.existsSync(this.walFile)) return;
    const lines = fs.readFileSync(this.walFile, 'utf8').split('\n').filter(Boolean);
    const prepares = new Map();
    const committed = new Set();
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.op === 'PREPARE') prepares.set(record.txId, record);
      else if (record.op === 'COMMIT') committed.add(record.txId);
      else if (record.op === 'ROLLBACK') {
        prepares.delete(record.txId);
        committed.delete(record.txId);
      }
    }
    let changed = false;
    for (const [txId, record] of prepares) {
      if (committed.has(txId)) {
        this.redo(record);
      } else {
        this.undo(record);
        this.appendWal({
          op: 'ROLLBACK',
          txId,
          groupId: record.groupId,
          ts: new Date().toISOString(),
          reason: 'crash-recovery',
        });
      }
      changed = true;
    }
    if (changed) this.save();
  }

  undo(record) {
    for (const [id, state] of Object.entries(record.snapshot?.states ?? {})) {
      const group = this.data.groups[id];
      if (group) {
        group.state = state;
        delete group.txId;
      }
    }
    const impact = record.budgetImpact;
    if (impact?.parentId && this.data.groups[impact.parentId]) {
      const parent = this.data.groups[impact.parentId];
      parent.pending = Math.max(0, (parent.pending ?? 0) - impact.amount);
    }
  }

  redo(record) {
    const group = this.data.groups[record.groupId];
    if (!group || group.state === 'SETTLED') return;
    group.state = 'SETTLED';
    delete group.txId;
    const impact = record.budgetImpact;
    if (impact?.parentId && this.data.groups[impact.parentId]) {
      const parent = this.data.groups[impact.parentId];
      parent.pending = Math.max(0, (parent.pending ?? 0) - impact.amount);
      parent.settled = (parent.settled ?? 0) + impact.amount;
    }
  }
}
