'use strict';

const crypto = require('node:crypto');
const { IntervalSet, makeError } = require('./intervals');

// Piecewise-constant-offset conversion table: each entry {local, utc} means
// that from `local` onward (until the next entry) utc = local + (utc - local).
class LocalToUtcConverter {
  constructor(table) {
    if (!Array.isArray(table) || table.length === 0) {
      throw makeError('ERR_CONVERSION_TABLE', 'conversion table must be a non-empty array');
    }
    for (const e of table) {
      if (!e || typeof e.local !== 'number' || typeof e.utc !== 'number') {
        throw makeError('ERR_CONVERSION_TABLE', `bad conversion entry: ${JSON.stringify(e)}`);
      }
    }
    this.entries = table
      .map((e) => ({ local: e.local, utc: e.utc }))
      .sort((a, b) => a.local - b.local);
  }

  toUtc(local) {
    let chosen = this.entries[0];
    for (const e of this.entries) {
      if (e.local <= local) chosen = e;
      else break;
    }
    return local + (chosen.utc - chosen.local);
  }
}

function cloneState(state) {
  const batches = new Map();
  for (const [id, b] of state.batches) batches.set(id, { ...b });
  const records = new Map();
  for (const [id, r] of state.records) {
    records.set(id, { version: r.version, record: { ...r.record, inputs: [...r.record.inputs] } });
  }
  return { batches, records };
}

function validateBatch(batch) {
  if (!batch || typeof batch.id !== 'string' || batch.id === '') {
    throw makeError('ERR_INVALID_BATCH', 'batch requires a non-empty string id');
  }
  for (const key of ['localStart', 'localEnd', 'shelfLife', 'packaging']) {
    if (typeof batch[key] !== 'number' || !Number.isFinite(batch[key])) {
      throw makeError('ERR_INVALID_BATCH', `batch ${batch.id}: ${key} must be a finite number`);
    }
  }
  if (batch.localStart > batch.localEnd) {
    throw makeError('ERR_INTERVAL_REVERSED', `batch ${batch.id}: production interval reversed`);
  }
  if (batch.shelfLife < 0) {
    throw makeError('ERR_NEGATIVE_SHELF_LIFE', `batch ${batch.id}: shelf life is negative`);
  }
  if (batch.packaging < 0) {
    throw makeError('ERR_NEGATIVE_PACKAGING', `batch ${batch.id}: packaging period is negative`);
  }
}

function validateRecord(record) {
  if (!record || typeof record.id !== 'string' || record.id === '') {
    throw makeError('ERR_INVALID_RECORD', 'genealogy record requires a non-empty string id');
  }
  if (!Array.isArray(record.inputs) || record.inputs.length === 0) {
    throw makeError('ERR_INVALID_RECORD', `record ${record.id}: inputs must be a non-empty array`);
  }
  if (typeof record.output !== 'string' || record.output === '') {
    throw makeError('ERR_INVALID_RECORD', `record ${record.id}: output must be a non-empty string`);
  }
}

class RecallStore {
  constructor(conversionTable) {
    this.converter = new LocalToUtcConverter(conversionTable);
    this.state = { batches: new Map(), records: new Map() };
    this.snapshots = new Map();
  }

  addBatch(batch) {
    validateBatch(batch);
    this.state.batches.set(batch.id, {
      id: batch.id,
      localStart: batch.localStart,
      localEnd: batch.localEnd,
      shelfLife: batch.shelfLife,
      packaging: batch.packaging,
    });
    return { ok: true };
  }

  addRecord(record) {
    validateRecord(record);
    if (this.state.records.has(record.id)) {
      throw makeError('ERR_DUPLICATE_RECORD', `record ${record.id} already exists; use correct`);
    }
    this.state.records.set(record.id, {
      version: 1,
      record: { id: record.id, inputs: [...record.inputs], output: record.output },
    });
    return { ok: true, version: 1 };
  }

  // Correction creates a new version of the record. Already-taken snapshots
  // keep pointing at the version they captured and are never mutated.
  correctRecord(record) {
    validateRecord(record);
    const existing = this.state.records.get(record.id);
    if (!existing) {
      throw makeError('ERR_UNKNOWN_RECORD', `cannot correct unknown record ${record.id}`);
    }
    const version = existing.version + 1;
    this.state.records.set(record.id, {
      version,
      record: { id: record.id, inputs: [...record.inputs], output: record.output },
    });
    return { ok: true, version };
  }

  snapshot(name) {
    if (typeof name !== 'string' || name === '') {
      throw makeError('ERR_INVALID_SNAPSHOT', 'snapshot name must be a non-empty string');
    }
    this.snapshots.set(name, cloneState(this.state));
    return { ok: true, snapshot: name };
  }

  rollback(name) {
    const snap = this.snapshots.get(name);
    if (!snap) {
      throw makeError('ERR_UNKNOWN_SNAPSHOT', `unknown snapshot: ${name}`);
    }
    this.state = cloneState(snap);
    return { ok: true, rolledBackTo: name };
  }

  // Enumerate every consumption path from `component` downstream.
  // Returns Map<productBatchId, Array<path>> where a path is an array of
  // {recordId, version, inputs, output}.
  static enumeratePaths(state, component) {
    const byInput = new Map();
    for (const { version, record } of state.records.values()) {
      for (const input of record.inputs) {
        if (!byInput.has(input)) byInput.set(input, []);
        byInput.get(input).push({ version, record });
      }
    }
    const paths = new Map();
    const visit = (batchId, path, onPath) => {
      const outs = byInput.get(batchId) || [];
      const usable = outs.filter((o) => !onPath.has(o.record.id));
      if (usable.length === 0) {
        if (!paths.has(batchId)) paths.set(batchId, []);
        paths.get(batchId).push(path);
        return;
      }
      for (const o of usable) {
        onPath.add(o.record.id);
        visit(
          o.record.output,
          [...path, { recordId: o.record.id, version: o.version, inputs: [...o.record.inputs], output: o.record.output }],
          onPath
        );
        onPath.delete(o.record.id);
      }
    };
    visit(component, [], new Set());
    return paths;
  }

  static certificate(snapshotName, path) {
    const canonical = JSON.stringify({ snapshot: snapshotName, path });
    const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
    return { snapshot: snapshotName, path, digest };
  }

  // query: {snapshot, component, observeStart, observeEnd} (observe* are UTC)
  query(q) {
    if (!q || typeof q !== 'object') {
      throw makeError('ERR_INVALID_QUERY', 'query must be an object');
    }
    const snap = this.snapshots.get(q.snapshot);
    if (!snap) {
      throw makeError('ERR_UNKNOWN_SNAPSHOT', `unknown snapshot: ${q.snapshot}`);
    }
    if (
      typeof q.observeStart !== 'number' ||
      typeof q.observeEnd !== 'number' ||
      !Number.isFinite(q.observeStart) ||
      !Number.isFinite(q.observeEnd)
    ) {
      throw makeError('ERR_INVALID_QUERY', 'observeStart/observeEnd must be finite numbers');
    }
    if (q.observeStart > q.observeEnd) {
      throw makeError(
        'ERR_INTERVAL_REVERSED',
        `observation interval reversed: [${q.observeStart}, ${q.observeEnd})`
      );
    }
    if (!snap.batches.has(q.component)) {
      throw makeError('ERR_UNKNOWN_BATCH', `unknown component batch: ${q.component}`);
    }

    const observe = IntervalSet.of(q.observeStart, q.observeEnd);
    const pathMap = RecallStore.enumeratePaths(snap, q.component);
    const results = [];
    for (const [productId, paths] of [...pathMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const batch = snap.batches.get(productId);
      if (!batch) {
        throw makeError('ERR_UNKNOWN_BATCH', `genealogy references undefined batch: ${productId}`);
      }
      const startUtc = this.converter.toUtc(batch.localStart);
      const endUtc = this.converter.toUtc(batch.localEnd);
      if (startUtc > endUtc) {
        throw makeError(
          'ERR_INTERVAL_REVERSED',
          `batch ${productId}: UTC conversion reversed the production interval`
        );
      }
      const shelfWindow = IntervalSet.of(endUtc, endUtc + batch.shelfLife);
      const packWindow = IntervalSet.of(endUtc, endUtc + batch.packaging);
      const shelfHit = observe.intersect(shelfWindow);
      const packHit = observe.intersect(packWindow);
      results.push({
        product: productId,
        productionUtc: { start: startUtc, end: endUtc },
        shelfLifeWindowUtc: { start: endUtc, end: endUtc + batch.shelfLife },
        packagingWindowUtc: { start: endUtc, end: endUtc + batch.packaging },
        withinShelfLife: !shelfHit.isEmpty(),
        hitIntervalUtc: shelfHit.toJSON(),
        inPackagingSeal: !packHit.isEmpty(),
        packagingHitIntervalUtc: packHit.toJSON(),
        certificates: paths.map((p) => RecallStore.certificate(q.snapshot, p)),
      });
    }
    return {
      snapshot: q.snapshot,
      component: q.component,
      observeUtc: { start: q.observeStart, end: q.observeEnd },
      affected: results,
    };
  }
}

module.exports = { RecallStore, LocalToUtcConverter };
