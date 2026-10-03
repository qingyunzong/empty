import fs from 'node:fs';
import path from 'node:path';
import { UndoError, ERR } from './errors.js';

// Layout inside the state directory:
//   batches/<n>.json  full committed snapshot of batch n (tmp + rename)
//   COMMIT            plain-text number of the latest committed batch
// A batch file without a COMMIT marker pointing at it is invisible on load,
// so a crash between the two writes is treated as "never undone".
export class StateStore {
  constructor(dir) {
    this.dir = dir;
    this.batchesDir = path.join(dir, 'batches');
    this.commitFile = path.join(dir, 'COMMIT');
  }

  static atomicWrite(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  // Returns { batch, undone, certificates }. Missing COMMIT => batch 0,
  // i.e. every uncommitted batch file is treated as never undone.
  load() {
    let batch = 0;
    try {
      const raw = fs.readFileSync(this.commitFile, 'utf8').trim();
      batch = Number.parseInt(raw, 10);
      if (!Number.isInteger(batch) || batch < 0) {
        throw new UndoError(ERR.CORRUPT_STATE, `invalid COMMIT marker: ${JSON.stringify(raw)}`);
      }
    } catch (err) {
      if (err instanceof UndoError) throw err;
      if (err.code !== 'ENOENT') throw err;
      return { batch: 0, undone: [], certificates: [] };
    }
    const undone = [];
    const certificates = [];
    for (let n = 1; n <= batch; n++) {
      const file = path.join(this.batchesDir, `${n}.json`);
      let snapshot;
      try {
        snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new UndoError(ERR.CORRUPT_STATE, `committed batch ${n} unreadable: ${err.message}`);
      }
      undone.push(...snapshot.undone);
      certificates.push(snapshot.certificate);
    }
    return { batch, undone, certificates };
  }

  // Persists one undo batch: snapshot file first, COMMIT marker last.
  commit(batch, { undone, certificate }) {
    const snapshot = { batch, undone: [...undone].sort(), certificate };
    StateStore.atomicWrite(
      path.join(this.batchesDir, `${batch}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    StateStore.atomicWrite(this.commitFile, `${batch}\n`);
    return snapshot;
  }
}
