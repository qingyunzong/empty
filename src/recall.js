import { IntervalSet, RecallError, checkInterval } from './intervals.js';
import { fmt } from './timeutil.js';

function windowsFor(batch) {
  const endUtc = batch.conversion.toUtc(batch.localEnd);
  const startUtc = batch.conversion.toUtc(batch.localStart);
  return {
    startUtc,
    endUtc,
    shelf: [endUtc, endUtc + batch.shelfLifeMs],
    packaging: [endUtc, endUtc + batch.packagingMs],
  };
}

function buildResult(batch, path, obs) {
  const w = windowsFor(batch);
  const shelfHit = obs.intersect(IntervalSet.of(w.shelf[0], w.shelf[1]));
  if (shelfHit.isEmpty()) return null;
  const packHit = obs.intersect(IntervalSet.of(w.packaging[0], w.packaging[1]));
  return {
    product: batch.id,
    hitInterval: shelfHit.intervals.map(([s, e]) => [fmt(s), fmt(e)]),
    inShelfLife: true,
    shelfLifeWindow: [fmt(w.shelf[0]), fmt(w.shelf[1])],
    inPackaging: !packHit.isEmpty(),
    packagingHitInterval: packHit.intervals.map(([s, e]) => [fmt(s), fmt(e)]),
    path: path.map((r) => ({ record: r.id, version: r.version, parent: r.parent, child: r.child })),
  };
}

function adjacencyOf(records) {
  const adj = new Map();
  for (const r of records) {
    if (!adj.has(r.parent)) adj.set(r.parent, []);
    adj.get(r.parent).push(r);
  }
  return adj;
}

export function traceRecall(store, defectId, obsStartMs, obsEndMs, snapshotName = null) {
  checkInterval(obsStartMs, obsEndMs, 'observation interval');
  const records = store.recordsFor(snapshotName);
  if (!store.batches.has(defectId)) {
    throw new RecallError('UNKNOWN_BATCH', `batch ${defectId} does not exist`);
  }
  const obs = IntervalSet.of(obsStartMs, obsEndMs);
  const adj = adjacencyOf(records);
  const results = [];
  const stack = [{ batchId: defectId, path: [] }];
  while (stack.length > 0) {
    const { batchId, path } = stack.pop();
    const onPath = new Set([defectId, ...path.map((r) => r.child)]);
    const usable = (adj.get(batchId) || []).filter((r) => !onPath.has(r.child));
    if (usable.length === 0) {
      if (path.length > 0) {
        const batch = store.batches.get(batchId);
        if (batch) {
          const res = buildResult(batch, path, obs);
          if (res) results.push(res);
        }
      }
      continue;
    }
    for (const r of usable) stack.push({ batchId: r.child, path: [...path, r] });
  }
  return results;
}

export function referenceRecall(store, defectId, obsStartMs, obsEndMs, snapshotName = null) {
  checkInterval(obsStartMs, obsEndMs, 'observation interval');
  const records = store.recordsFor(snapshotName);
  if (!store.batches.has(defectId)) {
    throw new RecallError('UNKNOWN_BATCH', `batch ${defectId} does not exist`);
  }
  const childrenOf = new Map();
  for (const r of records) {
    if (!childrenOf.has(r.parent)) childrenOf.set(r.parent, []);
    childrenOf.get(r.parent).push(r);
  }
  const results = [];
  const visit = (nodeId, path, onPath) => {
    const nexts = (childrenOf.get(nodeId) || []).filter((r) => !onPath.has(r.child));
    if (nexts.length === 0) {
      if (path.length === 0) return;
      const batch = store.batches.get(nodeId);
      if (!batch) return;
      const endUtc = batch.conversion.toUtc(batch.localEnd);
      const shelfS = endUtc;
      const shelfE = endUtc + batch.shelfLifeMs;
      const hitS = Math.max(obsStartMs, shelfS);
      const hitE = Math.min(obsEndMs, shelfE);
      if (hitS >= hitE) return;
      const packS = endUtc;
      const packE = endUtc + batch.packagingMs;
      const pS = Math.max(obsStartMs, packS);
      const pE = Math.min(obsEndMs, packE);
      results.push({
        product: batch.id,
        hitInterval: [[fmt(hitS), fmt(hitE)]],
        inShelfLife: true,
        shelfLifeWindow: [fmt(shelfS), fmt(shelfE)],
        inPackaging: pS < pE,
        packagingHitInterval: pS < pE ? [[fmt(pS), fmt(pE)]] : [],
        path: path.map((r) => ({ record: r.id, version: r.version, parent: r.parent, child: r.child })),
      });
      return;
    }
    for (const r of nexts) visit(r.child, [...path, r], new Set([...onPath, r.child]));
  };
  visit(defectId, [], new Set([defectId]));
  return results;
}
