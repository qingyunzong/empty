// Acceptance 3: both fault points recover to a predictable state and replay
// identically after restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../src/log.js';
import { truncateAt } from '../src/fault.js';
import { verify } from '../src/verifier.js';
import { run } from '../src/machine.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclave-log-'));
}

// Two committed batches of a valid history.
function writeTwoBatches(dir) {
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.append('lock_door');
  log.commit(); // segment 0
  log.append('heat_on');
  log.ack('pressure', 'HIGH');
  log.commit(); // segment 1
}

const BATCH1 = [
  { type: 'cmd', name: 'close_door' },
  { type: 'cmd', name: 'lock_door' },
];
const BATCH2 = [
  { type: 'cmd', name: 'heat_on' },
  { type: 'ack', sensor: 'pressure', value: 'HIGH' },
];

test('fault point 1: data written, commit not written -> batch discarded', () => {
  const dir = tmpdir();
  writeTwoBatches(dir);

  // crash lands between data and @COMMIT of segment 1: the commit record and
  // the manifest line were never written
  const seg1 = path.join(dir, 'seg-1.log');
  truncateAt(seg1, fs.readFileSync(seg1, 'utf8').indexOf('@COMMIT'));
  const manifest = path.join(dir, 'manifest.log');
  truncateAt(manifest, fs.readFileSync(manifest, 'utf8').indexOf('@MANIFEST 1'));

  const r1 = CommandLog.recover(dir);
  assert.deepEqual(r1.events, BATCH1);
  assert.deepEqual(r1.discarded, [1]);
  assert.deepEqual(r1.corrupt, []);

  // restart is deterministic: recovering again yields the same report
  const r2 = CommandLog.recover(dir);
  assert.deepEqual(r2, r1);

  // replay of recovered events matches the reference automaton on batch 1
  assert.deepEqual(verify(r1.events).safeState, run(BATCH1).state);

  // log keeps working: the discarded segment id is reused, no half commands
  const log = r1.log;
  log.append('heat_on');
  log.ack('pressure', 'HIGH');
  assert.equal(log.commit(), 1);
  const r3 = CommandLog.recover(dir);
  assert.deepEqual(r3.events, [...BATCH1, ...BATCH2]);
  assert.deepEqual(r3.corrupt, []);
});

test('fault point 2: commit written, manifest not written -> batch visible', () => {
  const dir = tmpdir();
  writeTwoBatches(dir);

  // crash lands between @COMMIT and the manifest append
  const manifest = path.join(dir, 'manifest.log');
  truncateAt(manifest, fs.readFileSync(manifest, 'utf8').indexOf('@MANIFEST 1'));

  const r1 = CommandLog.recover(dir);
  assert.deepEqual(r1.events, [...BATCH1, ...BATCH2]); // whole batch visible
  assert.deepEqual(r1.discarded, []);
  assert.deepEqual(r1.corrupt, []);
  assert.deepEqual(r1.manifested, [0]); // manifest honestly missing segment 1

  const r2 = CommandLog.recover(dir);
  assert.deepEqual(r2, r1);
  assert.deepEqual(verify(r1.events).safeState, run([...BATCH1, ...BATCH2]).state);
});

test('seeded random history: recover then replay is seed-consistent', () => {
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
  const CMDS = ['close_door', 'lock_door', 'heat_on', 'heat_off', 'open_vent', 'close_vent'];

  for (const seed of [7, 42, 1337]) {
    const dir = tmpdir();
    const rnd = mulberry32(seed);
    const log = CommandLog.open(dir);
    // batch 1: committed and manifested
    const batch1 = Array.from({ length: 3 }, () => CMDS[Math.floor(rnd() * CMDS.length)]);
    for (const c of batch1) log.append(c);
    log.commit();
    // batch 2: data written, then crash eats its @COMMIT and manifest lines
    const batch2 = Array.from({ length: 2 }, () => CMDS[Math.floor(rnd() * CMDS.length)]);
    for (const c of batch2) log.append(c);
    log.commit();
    const seg1 = path.join(dir, 'seg-1.log');
    truncateAt(seg1, fs.readFileSync(seg1, 'utf8').indexOf('@COMMIT'));
    const manifest = path.join(dir, 'manifest.log');
    truncateAt(manifest, fs.readFileSync(manifest, 'utf8').indexOf('@MANIFEST 1'));

    const recovered = CommandLog.recover(dir);
    const expected = batch1.map((name) => ({ type: 'cmd', name }));
    assert.deepEqual(recovered.events, expected, `seed=${seed}`);

    // replay after recovery == reference automaton on the same seed's batch 1
    assert.deepEqual(verify(recovered.events).safeState, run(expected).state, `seed=${seed}`);
    // and a second recovery replays identically
    assert.deepEqual(CommandLog.recover(dir), recovered, `seed=${seed}`);
  }
});
