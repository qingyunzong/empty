import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { readSegment, encodeEventRecord, SegmentEncoder } from '../src/segment.js';
import { E_IO, E_SEQ, E_RANGE } from '../src/errors.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plc-test-'));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force reference implementations over the plain event array.
function bruteCooccur(events, device, timeoutCode, window) {
  const hits = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].code !== timeoutCode) continue;
    const lo = Math.max(0, i - window);
    const hi = Math.min(events.length - 1, i + window);
    const matches = [];
    for (let j = lo; j <= hi; j++) {
      if (events[j].device === device) matches.push({ pos: j, distance: j - i, ...events[j] });
    }
    if (matches.length > 0) hits.push({ timeoutPos: i, timeoutSeq: events[i].seq, matches });
  }
  return hits;
}

function brutePhrase(events, codes) {
  const hits = [];
  outer: for (let i = 0; i + codes.length <= events.length; i++) {
    for (let k = 0; k < codes.length; k++) {
      if (events[i + k].code !== codes[k]) continue outer;
    }
    hits.push({ pos: i, seqs: events.slice(i, i + codes.length).map((e) => e.seq) });
  }
  return hits;
}

test('acceptance 1: random events match brute-force window enumeration', () => {
  const dir = tmpdir();
  const rng = mulberry32(42);
  const codes = ['ALARM', 'ACK', 'RESET', 'TIMEOUT', 'INFO', 'WARN'];
  const devices = ['D1', 'D2', 'D3', 'D4'];
  const events = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < 3000; i++) {
    ts += 1 + Math.floor(rng() * 50);
    events.push({
      seq: i,
      ts,
      code: codes[Math.floor(rng() * codes.length)],
      device: devices[Math.floor(rng() * devices.length)],
    });
  }

  // Ingest in three chunks with freezes in between -> spans multiple segments.
  const store = Store.open(dir, { create: true });
  store.ingest(events.slice(0, 1000));
  store.freeze();
  store.ingest(events.slice(1000, 2000));
  store.freeze();
  store.ingest(events.slice(2000));

  for (const device of devices) {
    for (const window of [0, 1, 5]) {
      const got = store.queryCooccur({ device, timeoutCode: 'TIMEOUT', window });
      assert.equal(got.events, events.length);
      assert.deepEqual(got.hits, bruteCooccur(events, device, 'TIMEOUT', window),
        `cooccur mismatch device=${device} window=${window}`);
    }
  }

  const phrase = ['ALARM', 'ACK', 'RESET'];
  assert.deepEqual(store.queryPhrase(phrase).hits, brutePhrase(events, phrase));
});

test('acceptance 2a: crash after append before fsync -> torn tail dropped and audited', () => {
  const dir = tmpdir();
  const events = Array.from({ length: 10 }, (_, i) => ({ seq: i, ts: 1000 + i, code: 'INFO', device: 'D1' }));
  Store.open(dir, { create: true }).ingest(events);

  // Simulate a torn write: half of a valid record appended, never fsynced.
  const segFile = path.join(dir, 'segments', fs.readdirSync(path.join(dir, 'segments'))[0]);
  const enc = new SegmentEncoder();
  const full = enc.encodeEvent({ seq: 99, ts: 2000, code: 'ALARM', device: 'D9' });
  fs.appendFileSync(segFile, full.subarray(0, Math.floor(full.length / 2)));

  const report = Store.recover(dir);
  const trunc = report.actions.filter((a) => a.action === 'truncated-partial');
  assert.equal(trunc.length, 1);
  assert.ok(trunc[0].droppedBytes > 0);

  // Auditable: audit.log records the dropped half-written record.
  const audit = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.match(audit, /truncated-partial/);

  // Data back to the last consistent state; recover is deterministic/idempotent.
  const store = Store.open(dir);
  assert.equal(store.loadEvents().length, 10);
  const report2 = Store.recover(dir);
  assert.equal(report2.actions.filter((a) => a.action === 'truncated-partial').length, 0);
  assert.equal(Store.open(dir).loadEvents().length, 10);
});

test('acceptance 2b: crash mid-manifest-write -> recover to last consistent manifest', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { create: true });
  store.ingest([{ seq: 1, ts: 100, code: 'ALARM', device: 'D1' }]);
  store.freeze();

  // Variant 1: manifest.json itself left half-written (garbage).
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":1,"seg');
  const report = Store.recover(dir);
  assert.ok(report.actions.some((a) => a.action === 'manifest-restored-from-bak'));
  assert.equal(Store.open(dir).loadEvents().length, 1);

  // Variant 2: stray half-written manifest tmp file; committed manifest wins.
  fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{"version":');
  const report2 = Store.recover(dir);
  assert.ok(report2.actions.some((a) => a.action === 'tmp-removed' && a.file === 'manifest.json.tmp'));
  assert.equal(Store.open(dir).loadEvents().length, 1);
});

test('acceptance 2c: crash before merge replaces segments -> orphan rolled back', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { create: true });
  const batch = (base) => Array.from({ length: 20 }, (_, i) => ({
    seq: base + i, ts: 1000 + base + i, code: i % 5 === 0 ? 'TIMEOUT' : 'INFO', device: `D${i % 3}`,
  }));
  store.ingest(batch(0));
  store.freeze();
  store.ingest(batch(100));
  store.freeze();
  store.ingest(batch(200)); // stays active

  const before = Store.open(dir).queryCooccur({ device: 'D1', timeoutCode: 'TIMEOUT', window: 5 });

  // Crash exactly after the merged segment is durable but before the manifest swap.
  class InjectedCrash extends Error {}
  assert.throws(() => Store.open(dir, {
    hooks: {
      beforeCompactManifestSwap() { throw new InjectedCrash('boom'); },
    },
  }).compact(), InjectedCrash);

  // Merged orphan segment exists on disk but is not referenced by the manifest.
  const segs = fs.readdirSync(path.join(dir, 'segments')).filter((f) => f.endsWith('.seg'));
  assert.equal(segs.length, 4);

  const report = Store.recover(dir);
  assert.ok(report.actions.some((a) => a.action === 'orphan-removed'));
  assert.equal(fs.readdirSync(path.join(dir, 'segments')).filter((f) => f.endsWith('.seg')).length, 3);

  const after = Store.open(dir).queryCooccur({ device: 'D1', timeoutCode: 'TIMEOUT', window: 5 });
  assert.deepEqual(after, before); // deterministic: state == pre-compact

  // A clean compact now succeeds and preserves query results.
  Store.open(dir).compact();
  assert.deepEqual(
    Store.open(dir).queryCooccur({ device: 'D1', timeoutCode: 'TIMEOUT', window: 5 }),
    before,
  );
});

test('acceptance 3: delete old code + compact -> neighbors no longer match', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { create: true });
  const events = [];
  for (let i = 0; i < 30; i++) events.push({ seq: i, ts: i * 10, code: 'INFO', device: 'D0' });
  events[10] = { seq: 10, ts: 100, code: 'TIMEOUT', device: 'D0' };
  events[8] = { seq: 8, ts: 80, code: 'OLD', device: 'D9' }; // within +/-5 of TIMEOUT
  events[12] = { seq: 12, ts: 120, code: 'OLD', device: 'D9' }; // within +/-5 of TIMEOUT
  store.ingest(events);

  const before = store.queryCooccur({ device: 'D9', timeoutCode: 'TIMEOUT', window: 5 });
  assert.equal(before.hits.length, 1);
  assert.equal(before.hits[0].matches.length, 2);

  // Tombstone only: logically invisible immediately, still physically present.
  store.deleteCode('OLD');
  assert.equal(store.queryCooccur({ device: 'D9', timeoutCode: 'TIMEOUT', window: 5 }).hits.length, 0);

  store.freeze();
  const compacted = store.compact();
  assert.equal(compacted.merged, true);
  assert.equal(compacted.purged, 2);

  // After compact the old code is physically gone and neighbors no longer hit.
  const after = Store.open(dir).queryCooccur({ device: 'D9', timeoutCode: 'TIMEOUT', window: 5 });
  assert.equal(after.hits.length, 0);
  assert.equal(after.events, 28);
  for (const f of fs.readdirSync(path.join(dir, 'segments'))) {
    assert.ok(!readSegment(path.join(dir, 'segments', f)).codes.includes('OLD'));
  }
});

test('acceptance 4: repeated ingest of the same seq is idempotent', () => {
  const dir = tmpdir();
  const batch = Array.from({ length: 50 }, (_, i) => ({ seq: i, ts: 5000 + i, code: 'INFO', device: 'D1' }));

  const s1 = Store.open(dir, { create: true });
  assert.deepEqual(s1.ingest(batch), { ingested: 50, deduped: 0 });
  assert.deepEqual(s1.ingest(batch), { ingested: 0, deduped: 50 }); // same process

  const s2 = Store.open(dir); // after "restart"
  assert.deepEqual(s2.ingest(batch), { ingested: 0, deduped: 50 });
  assert.equal(s2.loadEvents().length, 50);

  // Same seq with a different payload is a sequence conflict, not a dedup.
  assert.throws(
    () => s2.ingest([{ seq: 7, ts: 5007, code: 'ALARM', device: 'D1' }]),
    (err) => err.code === E_SEQ,
  );
  assert.equal(s2.loadEvents().length, 50);
});

test('error codes: E_IO, E_SEQ, E_RANGE', () => {
  const missing = path.join(tmpdir(), 'nope');
  assert.throws(() => Store.open(missing).queryCooccur({ device: 'D', timeoutCode: 'T' }),
    (err) => err.code === E_IO);

  const dir = tmpdir();
  const store = Store.open(dir, { create: true });
  assert.throws(() => store.ingest([{ seq: -1, ts: 0, code: 'A', device: 'D' }]),
    (err) => err.code === E_SEQ);
  assert.throws(() => store.ingest([{ seq: 0, ts: -5, code: 'A', device: 'D' }]),
    (err) => err.code === E_RANGE);
  assert.throws(() => store.queryCooccur({ device: 'D', timeoutCode: 'T', window: -1 }),
    (err) => err.code === E_RANGE);
  assert.throws(() => store.queryPhrase([]),
    (err) => err.code === E_RANGE);
});
