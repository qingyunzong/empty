import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WindowEngine,
  panesForTimestamp,
  PANE_WIDTH_MS,
  PANE_SLIDE_MS,
  FINALIZE_DELAY_MS,
  MAX_VERSION_UPDATES,
} from '../src/windows.js';
import { referencePane, referencePanesFor, referenceReplay } from './reference.js';

function upsert(sensorId, sampleId, ts, temp, version) {
  const ev = { type: 'UPSERT', sensorId, sampleId, ts, temp };
  if (version !== undefined) ev.version = version;
  return ev;
}

test('a sample maps to exactly 5 overlapping panes', () => {
  const ts = 300_000;
  const panes = panesForTimestamp(ts);
  assert.equal(panes.length, PANE_WIDTH_MS / PANE_SLIDE_MS);
  for (const start of panes) {
    assert.ok(start <= ts && ts < start + PANE_WIDTH_MS);
    assert.ok(start % PANE_SLIDE_MS === 0);
  }
  assert.deepEqual(panes, [-240_000, -120_000, 0, 120_000, 240_000]);
});

test('out-of-order sample affects 5 overlapping panes at once', () => {
  const engine = new WindowEngine();
  const r1 = engine.apply(upsert('s1', 'a', 300_000, 20));
  assert.equal(r1.error, null);
  assert.equal(r1.outputs.filter((o) => o.op === 'ADD').length, 5);

  const r2 = engine.apply(upsert('s1', 'b', 310_000, 22));
  assert.equal(r2.error, null);

  // Arrives late but has a much earlier event time: still touches 5 panes.
  const r3 = engine.apply(upsert('s1', 'c', 1_000, 30));
  assert.equal(r3.error, null);
  const touched = [...new Set(r3.outputs.map((o) => o.paneStart))].sort((x, y) => x - y);
  assert.deepEqual(touched, referencePanesFor(1_000));
  assert.equal(touched.length, 5);
  const ops = new Set(r3.outputs.map((o) => o.op));
  assert.ok(ops.has('ADD')); // brand-new panes -360000, -480000
  assert.ok(ops.has('WITHDRAW'));
  assert.ok(ops.has('CORRECTION')); // overlapping panes -240000, -120000, 0
  for (const o of r3.outputs) {
    assert.equal(o.sensorId, 's1');
    assert.match(o.certificate, /^[0-9a-f]{64}$/);
  }
});

test('retracting an outlier yields tied median and fewer outliers', () => {
  const engine = new WindowEngine();
  const temps = { a: 10, b: 11, c: 12, d: 13, e: 100 };
  for (const [id, temp] of Object.entries(temps)) {
    const r = engine.apply(upsert('s2', id, 0, temp));
    assert.equal(r.error, null);
  }
  const sensor = engine.sensors.get('s2');
  const before = sensor.panes.get(0).emitted;
  assert.equal(before.median, 12);
  assert.equal(before.mad, 1);
  assert.deepEqual(before.outlierIds, ['e']);

  const r = engine.apply({ type: 'RETRACT', sensorId: 's2', sampleId: 'e' });
  assert.equal(r.error, null);
  const forPane0 = r.outputs.filter((o) => o.paneStart === 0);
  assert.deepEqual(forPane0.map((o) => o.op), ['WITHDRAW', 'CORRECTION']);
  assert.deepEqual(forPane0[0].outlierIds, ['e']);
  const corrected = forPane0[1];
  // Even count: median is the average of the two middle values (11 and 12).
  assert.equal(corrected.median, 11.5);
  assert.equal(corrected.mad, 1);
  assert.deepEqual(corrected.outlierIds, []);
  assert.ok(corrected.outlierIds.length < forPane0[0].outlierIds.length);
});

test('correction budget: 9th version update is rejected', () => {
  const engine = new WindowEngine();
  assert.equal(engine.apply(upsert('s3', 'x', 0, 10, 1)).error, null);
  for (let v = 2; v <= MAX_VERSION_UPDATES + 1; v += 1) {
    const r = engine.apply(upsert('s3', 'x', 0, 10 + v, v));
    assert.equal(r.error, null, `version ${v} should be accepted`);
  }
  const rejected = engine.apply(upsert('s3', 'x', 0, 99, MAX_VERSION_UPDATES + 2));
  assert.equal(rejected.error.error, 'BUDGET_EXCEEDED');
  assert.equal(rejected.error.sensorId, 's3');
  assert.equal(rejected.outputs.length, 0);
  // Rejected correction must not change stored state.
  assert.equal(engine.sensors.get('s3').samples.get('x').temp, 10 + MAX_VERSION_UPDATES + 1);
  // Other samples of the same sensor still work.
  assert.equal(engine.apply(upsert('s3', 'y', 0, 20)).error, null);
});

test('stale versions are ignored without consuming budget', () => {
  const engine = new WindowEngine();
  engine.apply(upsert('s4', 'x', 0, 10, 5));
  const stale = engine.apply(upsert('s4', 'x', 0, 99, 3));
  assert.equal(stale.error, null);
  assert.equal(stale.outputs.length, 0);
  assert.equal(engine.sensors.get('s4').samples.get('x').temp, 10);
  assert.equal(engine.sensors.get('s4').corrections, 0);
});

test('late modifications after finalization are rejected', () => {
  const engine = new WindowEngine();
  engine.apply(upsert('s5', 'a', 0, 20));
  const finalizeAt = 0 + PANE_WIDTH_MS + FINALIZE_DELAY_MS;

  const early = engine.apply({ type: 'WATERMARK', sensorId: 's5', ts: finalizeAt - 1 });
  const earlyFinals = early.outputs.filter((o) => o.op === 'FINAL');
  assert.ok(earlyFinals.length > 0);
  assert.ok(earlyFinals.every((o) => o.paneStart < 0));

  const wm = engine.apply({ type: 'WATERMARK', sensorId: 's5', ts: finalizeAt });
  assert.equal(wm.error, null);
  const finals = wm.outputs.filter((o) => o.op === 'FINAL');
  assert.deepEqual(finals.map((o) => o.paneStart), [0]);

  const lateUpsert = engine.apply(upsert('s5', 'b', 0, 21));
  assert.equal(lateUpsert.error.error, 'LATE');
  assert.equal(lateUpsert.outputs.length, 0);

  const lateRetract = engine.apply({ type: 'RETRACT', sensorId: 's5', sampleId: 'a' });
  assert.equal(lateRetract.error.error, 'LATE');

  // A far-future sample only touches unfinalized panes and is accepted.
  const future = engine.apply(upsert('s5', 'c', finalizeAt + PANE_WIDTH_MS, 22));
  assert.equal(future.error, null);
});

test('retract of unknown sample is rejected', () => {
  const engine = new WindowEngine();
  const r = engine.apply({ type: 'RETRACT', sensorId: 's6', sampleId: 'ghost' });
  assert.equal(r.error.error, 'UNKNOWN_RETRACT');
  assert.equal(r.outputs.length, 0);
  engine.apply(upsert('s6', 'real', 0, 20));
  const r2 = engine.apply({ type: 'RETRACT', sensorId: 's6', sampleId: 'ghost' });
  assert.equal(r2.error.error, 'UNKNOWN_RETRACT');
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized stream matches independent brute-force reference', () => {
  const rand = mulberry32(42);
  const events = [];
  const sensorIds = ['ra', 'rb'];
  const everUpserted = new Map(sensorIds.map((s) => [s, []]));
  for (const sensorId of sensorIds) {
    for (let i = 0; i < 30; i += 1) {
      const ts = Math.floor(rand() * 900_000);
      const spike = rand() < 0.15;
      const temp = Math.round((18 + rand() * 6 + (spike ? (rand() < 0.5 ? -30 : 30) : 0)) * 100) / 100;
      const id = `${sensorId}-${i}`;
      events.push(upsert(sensorId, id, ts, temp));
      everUpserted.get(sensorId).push({ sampleId: id, ts, temp });
    }
  }
  // Shuffle upsert arrival order (out-of-order event time).
  for (let i = events.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  // Retract a few known samples after all upserts.
  for (const sensorId of sensorIds) {
    const mine = [...everUpserted.get(sensorId)];
    for (let i = mine.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [mine[i], mine[j]] = [mine[j], mine[i]];
    }
    for (const victim of mine.slice(0, 5)) {
      events.push({ type: 'RETRACT', sensorId, sampleId: victim.sampleId });
    }
  }
  const finalWatermark = 3_000_000;
  for (const sensorId of sensorIds) {
    events.push({ type: 'WATERMARK', sensorId, ts: finalWatermark });
  }

  const engine = new WindowEngine();
  const finalRecords = new Map();
  for (const ev of events) {
    const r = engine.apply(ev);
    assert.equal(r.error, null, `unexpected rejection of ${JSON.stringify(ev)}`);
    for (const o of r.outputs) {
      if (o.op === 'FINAL') finalRecords.set(`${o.sensorId}|${o.paneStart}`, o);
    }
    if (ev.type === 'UPSERT' || ev.type === 'RETRACT') {
      // Incremental recompute must agree with the reference on every affected pane.
      const sensor = engine.sensors.get(ev.sensorId);
      for (const [start, pane] of sensor.panes) {
        if (pane.finalized || !pane.emitted) continue;
        const ref = referencePane(ev.sensorId, start, [...sensor.samples.values()]);
        assert.deepEqual(
          { median: pane.emitted.median, mad: pane.emitted.mad, outlierIds: pane.emitted.outlierIds },
          { median: ref.median, mad: ref.mad, outlierIds: ref.outlierIds },
          `pane ${start} of ${ev.sensorId} diverged from reference`,
        );
      }
    }
  }

  const replayed = referenceReplay(events);
  for (const sensorId of sensorIds) {
    const expectedPanes = new Set();
    for (const s of everUpserted.get(sensorId)) {
      for (const start of referencePanesFor(s.ts)) {
        if (start + PANE_WIDTH_MS + FINALIZE_DELAY_MS <= finalWatermark) expectedPanes.add(start);
      }
    }
    const finalSamples = [...replayed.get(sensorId).values()];
    for (const start of expectedPanes) {
      const key = `${sensorId}|${start}`;
      assert.ok(finalRecords.has(key), `missing FINAL for ${key}`);
      const got = finalRecords.get(key);
      const ref = referencePane(sensorId, start, finalSamples);
      assert.equal(got.median, ref.median, `median mismatch for ${key}`);
      assert.equal(got.mad, ref.mad, `mad mismatch for ${key}`);
      assert.deepEqual(got.outlierIds, ref.outlierIds, `outliers mismatch for ${key}`);
      assert.match(got.certificate, /^[0-9a-f]{64}$/);
    }
    assert.equal(
      [...finalRecords.keys()].filter((k) => k.startsWith(`${sensorId}|`)).length,
      expectedPanes.size,
    );
  }
});

test('certificates are deterministic across runs', () => {
  const run = () => {
    const engine = new WindowEngine();
    engine.apply(upsert('s7', 'a', 0, 20));
    engine.apply(upsert('s7', 'b', 60_000, 21));
    const wm = engine.apply({ type: 'WATERMARK', sensorId: 's7', ts: 10_000_000 });
    return wm.outputs.map((o) => o.certificate);
  };
  assert.deepEqual(run(), run());
});

import { run as runCliMain } from '../src/cli.js';

function runCli(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sensor-windows-'));
  const file = join(dir, 'samples.jsonl');
  writeFileSync(file, lines.join('\n'));
  const io = {
    stdout: { buf: '', write(s) { this.buf += s; } },
    stderr: { buf: '', write(s) { this.buf += s; } },
  };
  const status = runCliMain(['node', 'src/cli.js', 'windows', '--in', file], io);
  return { status, stdout: io.stdout.buf, stderr: io.stderr.buf };
}

test('CLI emits JSONL results and per-event errors on stderr', () => {
  const proc = runCli([
    JSON.stringify(upsert('c1', 'a', 0, 20)),
    JSON.stringify(upsert('c1', 'b', 120_000, 22)),
    JSON.stringify({ type: 'RETRACT', sensorId: 'c1', sampleId: 'ghost' }),
    JSON.stringify({ type: 'WATERMARK', sensorId: 'c1', ts: 10_000_000 }),
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const records = proc.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(records.length > 0);
  const ops = records.map((r) => r.op);
  assert.ok(ops.includes('ADD'));
  assert.ok(ops.includes('FINAL'));
  for (const r of records) {
    assert.equal(typeof r.sensorId, 'string');
    assert.equal(typeof r.paneStart, 'number');
    assert.ok('median' in r && 'mad' in r && Array.isArray(r.outlierIds));
    assert.match(r.certificate, /^[0-9a-f]{64}$/);
  }
  const errors = proc.stderr.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'UNKNOWN_RETRACT');
  assert.equal(errors[0].line, 3);
});

test('CLI exits with code 2 on fatal input', () => {
  const badJson = runCli(['{"type":"UPSERT", broken']);
  assert.equal(badJson.status, 2);
  assert.equal(JSON.parse(badJson.stderr.trim()).error, 'INVALID_INPUT');

  const missingField = runCli([JSON.stringify({ type: 'UPSERT', sensorId: 'c2' })]);
  assert.equal(missingField.status, 2);

  const unknownType = runCli([JSON.stringify({ type: 'PING', sensorId: 'c2' })]);
  assert.equal(unknownType.status, 2);

  const io = {
    stdout: { buf: '', write(s) { this.buf += s; } },
    stderr: { buf: '', write(s) { this.buf += s; } },
  };
  const status = runCliMain(['node', 'src/cli.js', 'windows', '--in', '/nonexistent.jsonl'], io);
  assert.equal(status, 2);
  assert.equal(JSON.parse(io.stderr.buf.trim()).error, 'INVALID_INPUT');
});
