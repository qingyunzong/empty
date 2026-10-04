import { RecallError, checkInterval } from './intervals.js';
import { ConversionTable, parseLocal } from './timeutil.js';

export class Store {
  constructor() {
    this.batches = new Map();
    this.recordVersions = new Map();
    this.current = new Map();
    this.snapshots = new Map();
  }

  addBatch(b) {
    const localStart = parseLocal(b.localStart);
    const localEnd = parseLocal(b.localEnd);
    checkInterval(localStart, localEnd, `batch ${b.id} production interval`);
    if (typeof b.shelfLifeMs !== 'number' || b.shelfLifeMs < 0) {
      throw new RecallError('NEGATIVE_SHELF_LIFE', `batch ${b.id} has negative shelf life`);
    }
    if (typeof b.packagingMs !== 'number' || b.packagingMs < 0) {
      throw new RecallError('NEGATIVE_PACKAGING', `batch ${b.id} has negative packaging period`);
    }
    this.batches.set(b.id, {
      id: b.id,
      localStart,
      localEnd,
      shelfLifeMs: b.shelfLifeMs,
      packagingMs: b.packagingMs,
      conversion: new ConversionTable(b.conversion),
    });
  }

  addRecord(r) {
    if (this.recordVersions.has(r.id)) {
      throw new RecallError('DUPLICATE_RECORD', `record ${r.id} already exists`);
    }
    this.recordVersions.set(r.id, [{ version: 1, id: r.id, parent: r.parent, child: r.child }]);
    this.current.set(r.id, 1);
  }

  correctRecord(r) {
    const versions = this.recordVersions.get(r.id);
    if (!versions) throw new RecallError('UNKNOWN_RECORD', `record ${r.id} does not exist`);
    const v = { version: versions.length + 1, id: r.id, parent: r.parent, child: r.child };
    versions.push(v);
    this.current.set(r.id, v.version);
  }

  snapshot(name) {
    this.snapshots.set(name, new Map(this.current));
  }

  rollback(name) {
    const snap = this.snapshots.get(name);
    if (!snap) throw new RecallError('UNKNOWN_SNAPSHOT', `snapshot ${name} does not exist`);
    this.current = new Map(snap);
  }

  recordsFor(snapshotName = null) {
    if (snapshotName == null) return this.resolve(this.current);
    const snap = this.snapshots.get(snapshotName);
    if (!snap) throw new RecallError('UNKNOWN_SNAPSHOT', `snapshot ${snapshotName} does not exist`);
    return this.resolve(snap);
  }

  resolve(versionMap) {
    const out = [];
    for (const [id, v] of versionMap) out.push(this.recordVersions.get(id)[v - 1]);
    return out;
  }
}
