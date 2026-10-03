import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AlertStore,
  AlertError,
  buildSegmentBuffer,
  segmentName,
  HEADER_SIZE,
  RECORD_SIZE,
} from '../src/store.js';
import { run as cliRun } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alert-store-'));
}

const bySeverityDeviceSeq = (x, y) =>
  (x.severity - y.severity) ||
  (x.device < y.device ? -1 : x.device > y.device ? 1 : 0) ||
  (x.seq - y.seq);

test('manual fold of a small sequence set matches replay output', () => {
  const dir = tmpdir();
  const store = new AlertStore(dir);
  const inputs = [
    { device: 'dev-b', seq: 1, severity: 5, message: 'b1', ts: 1 },
    { device: 'dev-a', seq: 1, severity: 5, message: 'a1', ts: 2 },
    { device: 'dev-c', seq: 1, severity: 5, message: 'c1', ts: 3 },
    { device: 'dev-a', seq: 2, severity: 1, message: 'a2', ts: 4 },
    { device: 'dev-b', seq: 2, severity: 3, message: 'b2', ts: 5 },
    { device: 'dev-b', seq: 3, severity: 5, message: 'b3', ts: 6 },
  ];
  for (const i of inputs) assert.equal(store.append(i).status, 'ok');

  // Manual fold: severity first, ties broken by device id then seq.
  const expected = [...inputs].sort(bySeverityDeviceSeq).map((i) => i.message);
  const { alerts, cursor } = store.replay();
  assert.deepEqual(alerts.map((a) => a.message), expected);

  // Cursor replay is incremental: nothing new beyond the acknowledged prefix.
  assert.equal(store.replay(cursor).alerts.length, 0);
  store.append({ device: 'dev-a', seq: 3, severity: 2, message: 'a3', ts: 7 });
  const again = store.replay(cursor);
  assert.deepEqual(again.alerts.map((a) => a.message), ['a3']);
  store.close();
});

test('packet loss produces E_GAP and keeps the contiguous prefix', () => {
  const dir = tmpdir();
  const store = new AlertStore(dir);
  store.append({ device: 'dev-a', seq: 1, message: 'm1' });
  store.append({ device: 'dev-a', seq: 2, message: 'm2' });

  let err;
  try {
    store.append({ device: 'dev-a', seq: 4, message: 'm4' });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AlertError && err.code === 'E_GAP');
  assert.equal(err.expected, 3n);
  assert.equal(err.got, 4n);

  // The hole is not skipped: seq 4 was not stored, prefix 1..2 is intact.
  assert.deepEqual(store.replay().alerts.map((a) => Number(a.seq)), [1, 2]);

  // Filling the hole resumes the contiguous sequence.
  store.append({ device: 'dev-a', seq: 3, message: 'm3' });
  store.append({ device: 'dev-a', seq: 4, message: 'm4' });
  assert.deepEqual(store.replay().alerts.map((a) => Number(a.seq)), [1, 2, 3, 4]);
  store.close();
});

test('duplicate sends are idempotently ignored and counted', () => {
  const dir = tmpdir();
  const store = new AlertStore(dir);
  assert.equal(store.append({ device: 'dev-a', seq: 1, message: 'm1' }).status, 'ok');
  assert.deepEqual(store.append({ device: 'dev-a', seq: 1, message: 'm1' }), { status: 'duplicate', dedup: 1 });
  assert.deepEqual(store.append({ device: 'dev-a', seq: 1, message: 'm1' }), { status: 'duplicate', dedup: 2 });
  store.append({ device: 'dev-a', seq: 2, message: 'm2' });
  assert.equal(store.append({ device: 'dev-a', seq: 1, message: 'm1' }).dedup, 3);
  assert.equal(store.append({ device: 'dev-a', seq: 2, message: 'm2' }).dedup, 1);

  assert.equal(store.stats().duplicates, 4);
  assert.deepEqual(store.replay().alerts.map((a) => Number(a.seq)), [1, 2]);
  store.close();
});

test('one-byte corruption inside a segment produces E_CRC', () => {
  const dir = tmpdir();
  const store = new AlertStore(dir);
  for (let seq = 1; seq <= 3; seq++) store.append({ device: 'dev-a', seq, message: `m${seq}` });
  store.close();

  const segFile = path.join(dir, 'segments', segmentName(1));
  const buf = fs.readFileSync(segFile);
  buf[HEADER_SIZE + 40] ^= 0xff; // flip one byte inside the first record
  fs.writeFileSync(segFile, buf);

  assert.throws(() => new AlertStore(dir), (e) => e instanceof AlertError && e.code === 'E_CRC');
});

test('crash before manifest rename keeps the cursor-certified prefix', () => {
  const dir = tmpdir();
  const opts = { segmentSize: HEADER_SIZE + 2 * RECORD_SIZE, maxSegments: 2 };
  let store = new AlertStore(dir, opts);
  for (let seq = 1; seq <= 4; seq++) {
    store.append({ device: 'dev-a', seq, severity: 1, message: `m${seq}`, ts: seq });
  }
  const { cursor } = store.replay();
  assert.ok(store.verifyCursor(cursor));
  store.close();
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).segments,
    [segmentName(1), segmentName(2)],
  );

  // Simulate a crash mid-overwrite: new segment and staged manifest written,
  // process dies before the atomic rename.
  fs.writeFileSync(
    path.join(dir, 'segments', segmentName(3)),
    buildSegmentBuffer(
      [
        { device: 'dev-a', seq: 5, severity: 1, message: 'm5', ts: 5 },
        { device: 'dev-a', seq: 6, severity: 1, message: 'm6', ts: 6 },
      ],
      opts.segmentSize,
    ),
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.json.tmp'),
    JSON.stringify({ version: 1, segments: [segmentName(2), segmentName(3)], nextSegmentId: 4 }),
  );

  store = new AlertStore(dir, opts);
  // The old manifest won: the acknowledged prefix the cursor certifies is unchanged.
  assert.ok(store.verifyCursor(cursor));
  assert.deepEqual(store.replay().alerts.map((a) => Number(a.seq)), [1, 2, 3, 4]);
  assert.equal(store.replay(cursor).alerts.length, 0);
  // Uncommitted artifacts are cleaned up.
  assert.equal(fs.existsSync(path.join(dir, 'segments', segmentName(3))), false);
  assert.equal(fs.existsSync(path.join(dir, 'manifest.json.tmp')), false);
  store.close();
});

test('after the rename the new segment list takes effect and the ring evicts', () => {
  const dir = tmpdir();
  const opts = { segmentSize: HEADER_SIZE + 2 * RECORD_SIZE, maxSegments: 2 };
  const store = new AlertStore(dir, opts);
  for (let seq = 1; seq <= 4; seq++) {
    store.append({ device: 'dev-a', seq, message: `m${seq}` });
  }
  const { cursor } = store.replay();

  store.append({ device: 'dev-a', seq: 5, message: 'm5' }); // rotates: seg3 in, seg1 out
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.segments, [segmentName(2), segmentName(3)]);
  assert.equal(fs.existsSync(path.join(dir, 'segments', segmentName(1))), false);

  // New data is replayable beyond the old cursor; the evicted prefix is gone.
  assert.deepEqual(store.replay(cursor).alerts.map((a) => Number(a.seq)), [5]);
  assert.equal(store.verifyCursor(cursor), false);
  assert.deepEqual(store.replay().alerts.map((a) => Number(a.seq)), [3, 4, 5]);

  // Reopen from disk and confirm the committed state survives.
  store.close();
  const reopened = new AlertStore(dir, opts);
  assert.deepEqual(reopened.replay().alerts.map((a) => Number(a.seq)), [3, 4, 5]);
  reopened.close();
});

test('index snapshot records device, min/max seq and file offsets', () => {
  const dir = tmpdir();
  const opts = { segmentSize: HEADER_SIZE + 2 * RECORD_SIZE, maxSegments: 4 };
  const store = new AlertStore(dir, opts);
  for (let seq = 1; seq <= 3; seq++) store.append({ device: 'dev-a', seq, message: `a${seq}` });
  store.append({ device: 'dev-b', seq: 1, message: 'b1' });
  store.close();

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.devices['dev-a'].minSeq, '1');
  assert.equal(index.devices['dev-a'].maxSeq, '3');
  assert.equal(index.devices['dev-b'].minSeq, '1');
  assert.deepEqual(
    index.devices['dev-a'].offsets,
    [
      { seq: '1', segment: segmentName(1), offset: HEADER_SIZE },
      { seq: '2', segment: segmentName(1), offset: HEADER_SIZE + RECORD_SIZE },
      { seq: '3', segment: segmentName(2), offset: HEADER_SIZE },
    ],
  );
});

test('CLI: append, replay with cursor, E_GAP exit code', () => {
  const dir = tmpdir();
  const run = (args) => {
    const out = [];
    const err = [];
    const status = cliRun(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { status, stdout: out.join('\n'), stderr: err.join('\n') };
  };

  let r = run(['append', '--dir', dir, '--device', 'd1', '--seq', '1', '--severity', '2', '--message', 'hello', '--ts', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'ok');

  r = run(['append', '--dir', dir, '--device', 'd1', '--seq', '1', '--message', 'hello', '--ts', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'duplicate');

  r = run(['append', '--dir', dir, '--device', 'd1', '--seq', '3', '--message', 'lost']);
  assert.equal(r.status, 3);
  const gap = JSON.parse(r.stderr);
  assert.equal(gap.code, 'E_GAP');
  assert.equal(gap.expected, '2');

  r = run(['append', '--dir', dir, '--device', 'd1', '--seq', '2', '--severity', '1', '--message', 'world', '--ts', '20']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['replay', '--dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(r.stdout);
  assert.deepEqual(first.alerts.map((a) => a.message), ['world', 'hello']); // severity order
  assert.ok(first.cursor);

  r = run(['replay', '--dir', dir, '--cursor', first.cursor]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).alerts.length, 0);

  r = run(['verify', '--dir', dir, '--cursor', first.cursor]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).valid, true);
});
