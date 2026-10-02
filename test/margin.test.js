import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createState, setMargin, applyEvent, mergeStates,
  position, certificate, cli,
} from '../margin.js';

// Invokes the CLI in-process (this sandbox forbids spawning child processes).
function runCli(args) {
  let text = '';
  const code = cli(args, (s) => { text += s; });
  return { code, json: JSON.parse(text) };
}

const freeze = (eventId, freezeId, symbol, amount) => ({ eventId, freezeId, symbol, amount });
const release = (eventId, freezeId, amount) => ({ eventId, freezeId, amount });

function freshState(margin = 1000, symbol = 'AAPL') {
  const s = createState();
  setMargin(s, symbol, margin);
  return s;
}

// Independent reference: pure summation table, no sequential replay logic.
function referencePosition(margin, events) {
  const frozenSum = new Map(); // freezeId -> total frozen
  const releasedSum = new Map(); // freezeId -> total released
  let frozenTotal = 0;
  let releasedTotal = 0;
  for (const ev of events) {
    if (ev.type === 'freeze') {
      frozenSum.set(ev.freezeId, (frozenSum.get(ev.freezeId) || 0) + ev.amount);
      frozenTotal += ev.amount;
    } else {
      releasedSum.set(ev.freezeId, (releasedSum.get(ev.freezeId) || 0) + ev.amount);
      releasedTotal += ev.amount;
    }
  }
  const frozen = [];
  const tombstones = [];
  for (const [fid, amount] of [...frozenSum.keys()].sort().map((k) => [k, frozenSum.get(k)])) {
    const rel = releasedSum.get(fid) || 0;
    const remaining = amount - rel;
    if (remaining === 0) tombstones.push(fid);
    else frozen.push({ freezeId: fid, amount, released: rel, remaining });
  }
  return { available: margin - frozenTotal + releasedTotal, frozen, tombstones };
}

test('acceptance 1: concurrent freezes on two replicas merge with correct available', () => {
  const a = freshState(1000);
  const b = freshState(1000);
  applyEvent(a, freeze('e1', 'f1', 'AAPL', 250), 'freeze');
  applyEvent(a, freeze('e2', 'f2', 'AAPL', 150), 'freeze');
  applyEvent(b, freeze('e3', 'f3', 'AAPL', 300), 'freeze');

  const merged = mergeStates(a, b);
  const pos = position(merged, 'AAPL');
  assert.equal(pos.available, 300); // 1000 - 250 - 150 - 300
  assert.deepEqual(pos.frozen.map((f) => [f.freezeId, f.remaining]), [
    ['f1', 250], ['f2', 150], ['f3', 300],
  ]);

  // merging is idempotent and commutative
  assert.equal(position(mergeStates(merged, b), 'AAPL').available, 300);
  assert.equal(position(mergeStates(b, a), 'AAPL').available, 300);
});

test('acceptance 2: partial releases accumulate, tombstone retained, no resurrection', () => {
  const s = freshState(1000);
  applyEvent(s, freeze('e1', 'f1', 'AAPL', 200), 'freeze');
  applyEvent(s, release('r1', 'f1', 50), 'release');
  let pos = position(s, 'AAPL');
  assert.equal(pos.available, 850);
  assert.deepEqual(pos.frozen, [{ freezeId: 'f1', amount: 200, released: 50, remaining: 150 }]);
  assert.deepEqual(pos.tombstones, []);

  applyEvent(s, release('r2', 'f1', 150), 'release');
  pos = position(s, 'AAPL');
  assert.equal(pos.available, 1000);
  assert.deepEqual(pos.frozen, []);
  assert.deepEqual(pos.tombstones, ['f1']); // fully released -> tombstone

  // stale duplicate of an already-applied release event is an idempotent no-op
  applyEvent(s, release('r2', 'f1', 150), 'release');
  pos = position(s, 'AAPL');
  assert.equal(pos.available, 1000);
  assert.deepEqual(pos.tombstones, ['f1']);

  // a *new* release event against the tombstone is rejected and cannot resurrect the freeze
  assert.throws(() => applyEvent(s, release('r3', 'f1', 10), 'release'), (e) => e.code === 'over-release');
  pos = position(s, 'AAPL');
  assert.equal(pos.available, 1000);
  assert.deepEqual(pos.frozen, []);
  assert.deepEqual(pos.tombstones, ['f1']);
});

test('acceptance 3: over-release, unknown-freeze, insufficient-margin', () => {
  const s = freshState(100);
  assert.throws(() => applyEvent(s, freeze('e1', 'f1', 'AAPL', 101), 'freeze'), (e) => e.code === 'insufficient-margin');
  applyEvent(s, freeze('e1', 'f1', 'AAPL', 60), 'freeze');
  assert.throws(() => applyEvent(s, release('r1', 'nope', 10), 'release'), (e) => e.code === 'unknown-freeze');
  assert.throws(() => applyEvent(s, release('r1', 'f1', 61), 'release'), (e) => e.code === 'over-release');
  applyEvent(s, release('r1', 'f1', 60), 'release');
  assert.throws(() => applyEvent(s, release('r2', 'f1', 1), 'release'), (e) => e.code === 'over-release');
});

test('event idempotency: identical payload no-op, different payload rejected', () => {
  const s = freshState(500);
  const r1 = applyEvent(s, freeze('e1', 'f1', 'AAPL', 100), 'freeze');
  assert.equal(r1.changed, true);
  const r2 = applyEvent(s, freeze('e1', 'f1', 'AAPL', 100), 'freeze');
  assert.equal(r2.changed, false);
  assert.equal(position(s, 'AAPL').available, 400);
  assert.throws(() => applyEvent(s, freeze('e1', 'f1', 'AAPL', 200), 'freeze'), (e) => e.code === 'event-conflict');
  assert.throws(() => applyEvent(s, release('e1', 'f1', 50), 'release'), (e) => e.code === 'event-conflict');
});

test('merge rejects conflicting event payloads and margin conflicts', () => {
  const a = freshState(1000);
  const b = freshState(1000);
  applyEvent(a, freeze('e1', 'f1', 'AAPL', 100), 'freeze');
  applyEvent(b, freeze('e1', 'f1', 'AAPL', 200), 'freeze');
  assert.throws(() => mergeStates(a, b), (e) => e.code === 'event-conflict');

  const c = freshState(1000);
  const d = createState();
  setMargin(d, 'AAPL', 999);
  assert.throws(() => mergeStates(c, d), (e) => e.code === 'margin-conflict');
});

test('merge detects combined freezes exceeding margin', () => {
  const a = freshState(1000);
  const b = freshState(1000);
  applyEvent(a, freeze('e1', 'f1', 'AAPL', 600), 'freeze');
  applyEvent(b, freeze('e2', 'f2', 'AAPL', 600), 'freeze');
  assert.throws(() => mergeStates(a, b), (e) => e.code === 'insufficient-margin');
});

test('certificate contains symbol, available, frozen list and release hash', () => {
  const s = freshState(1000);
  applyEvent(s, freeze('e1', 'f1', 'AAPL', 200), 'freeze');
  applyEvent(s, freeze('e2', 'f2', 'AAPL', 100), 'freeze');
  applyEvent(s, release('r1', 'f2', 100), 'release');
  const cert = certificate(s, 'AAPL');
  assert.equal(cert.symbol, 'AAPL');
  assert.equal(cert.available, 800);
  assert.deepEqual(cert.frozen, [{ freezeId: 'f1', amount: 200, released: 0, remaining: 200 }]);
  assert.match(cert.releases.f2, /^[0-9a-f]{64}$/);
  assert.match(cert.releaseHash, /^[0-9a-f]{64}$/);
  // certificate is deterministic
  assert.deepEqual(certificate(s, 'AAPL'), cert);
});

test('enumeration: subsets and duplicates of freeze/release events match reference sums', () => {
  const MARGIN = 1000;
  const base = [
    { type: 'freeze', ...freeze('e1', 'f1', 'AAPL', 60) },
    { type: 'freeze', ...freeze('e2', 'f2', 'AAPL', 40) },
    { type: 'release', ...release('e3', 'f1', 20) },
    { type: 'release', ...release('e4', 'f1', 40) }, // completes f1 -> tombstone
    { type: 'release', ...release('e5', 'f2', 40) }, // completes f2 -> tombstone
  ];
  // a release is only valid when its freeze is part of the same sequence
  const valid = (mask) => (!(mask & 0b01100) || (mask & 0b00001)) && (!(mask & 0b10000) || (mask & 0b00010));
  let cases = 0;
  for (let subset = 0; subset < (1 << base.length); subset++) {
    if (!valid(subset)) continue;
    for (let dup = 0; dup < (1 << base.length); dup++) {
      const seq = [];
      const deduped = [];
      for (let i = 0; i < base.length; i++) {
        if (!(subset & (1 << i))) continue;
        seq.push(base[i]);
        deduped.push(base[i]);
        if (dup & (1 << i)) seq.push(base[i]); // exact duplicate must be idempotent
      }
      const s = freshState(MARGIN);
      for (const ev of seq) applyEvent(s, ev, ev.type);
      const pos = position(s, 'AAPL');
      const ref = referencePosition(MARGIN, deduped);
      assert.equal(pos.available, ref.available, `subset=${subset} dup=${dup} available`);
      assert.deepEqual(pos.frozen, ref.frozen, `subset=${subset} dup=${dup} frozen`);
      assert.deepEqual(pos.tombstones, ref.tombstones, `subset=${subset} dup=${dup} tombstones`);
      cases++;
    }
  }
  assert.equal(cases, 15 * 32);
});

test('enumeration: shuffled replicas merge to the same reference result', () => {
  const MARGIN = 500;
  const events = [
    { type: 'freeze', ...freeze('e1', 'f1', 'AAPL', 120) },
    { type: 'freeze', ...freeze('e2', 'f2', 'AAPL', 80) },
    { type: 'release', ...release('e3', 'f1', 70) },
    { type: 'release', ...release('e4', 'f1', 50) }, // f1 fully released
  ];
  const ref = referencePosition(MARGIN, events);
  // every valid partition of the event set across two replicas must merge identically
  // (a release must reside on the same replica as its freeze to apply locally)
  let partitions = 0;
  for (let mask = 0; mask < (1 << events.length); mask++) {
    const f1group = mask & 0b1101; // freeze f1 and its releases must share a replica
    if (f1group !== 0 && f1group !== 0b1101) continue;
    partitions++;
    const a = freshState(MARGIN);
    const b = freshState(MARGIN);
    for (let i = 0; i < events.length; i++) {
      applyEvent(mask & (1 << i) ? a : b, events[i], events[i].type);
    }
    const pos = position(mergeStates(a, b), 'AAPL');
    assert.equal(pos.available, ref.available, `mask=${mask}`);
    assert.deepEqual(pos.frozen, ref.frozen, `mask=${mask}`);
    assert.deepEqual(pos.tombstones, ref.tombstones, `mask=${mask}`);
  }
  assert.equal(partitions, 4);
});

test('CLI end-to-end: init/freeze/release/merge/position/cert and error exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margin-'));
  const fA = join(dir, 'a.json');
  const fB = join(dir, 'b.json');

  let r = runCli(['init', fA, 'AAPL', '1000']);
  assert.equal(r.code, 0);
  assert.equal(r.json.available, 1000);
  r = runCli(['init', fB, 'AAPL', '1000']);
  assert.equal(r.code, 0);

  // concurrent freezes on two replicas
  r = runCli(['freeze', fA, JSON.stringify(freeze('e1', 'f1', 'AAPL', 300))]);
  assert.equal(r.code, 0);
  assert.equal(r.json.available, 700);
  r = runCli(['freeze', fB, JSON.stringify(freeze('e2', 'f2', 'AAPL', 200))]);
  assert.equal(r.code, 0);

  r = runCli(['merge', fA, fB]);
  assert.equal(r.code, 0);
  assert.equal(r.json.AAPL.available, 500);

  // partial release, then completing release -> tombstone
  r = runCli(['release', fA, JSON.stringify(release('e3', 'f1', 100))]);
  assert.equal(r.code, 0);
  r = runCli(['release', fA, JSON.stringify(release('e4', 'f1', 200))]);
  assert.equal(r.code, 0);
  r = runCli(['position', fA, 'AAPL']);
  assert.equal(r.json.available, 800);
  assert.deepEqual(r.json.tombstones, ['f1']);

  // cert
  r = runCli(['cert', fA, 'AAPL']);
  assert.equal(r.code, 0);
  assert.equal(r.json.symbol, 'AAPL');
  assert.equal(r.json.available, 800);
  assert.equal(r.json.frozen.length, 1);
  assert.match(r.json.releaseHash, /^[0-9a-f]{64}$/);

  // error cases: JSON error on stdout, exit code 1
  r = runCli(['release', fA, JSON.stringify(release('e5', 'f1', 1))]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'over-release' });
  r = runCli(['release', fA, JSON.stringify(release('e6', 'ghost', 1))]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'unknown-freeze' });
  r = runCli(['freeze', fA, JSON.stringify(freeze('e7', 'f9', 'AAPL', 99999))]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'insufficient-margin' });
  r = runCli(['freeze', fA, JSON.stringify(freeze('e4', 'fx', 'AAPL', 5))]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'event-conflict' });

  // failed commands must not corrupt the state file
  r = runCli(['position', fA, 'AAPL']);
  assert.equal(r.json.available, 800);
});
