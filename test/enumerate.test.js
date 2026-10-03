import test from 'node:test';
import assert from 'node:assert/strict';
import { Processor, WINDOW_MS } from '../src/processor.js';
import { HASH_A } from './helpers.js';

// Independent reference implementation used to cross-check the library.
function referenceStates(events) {
  const barcodes = new Map(); // op -> {frame, case, retracted}
  const visions = []; // {frame, sku, hasDefect, retracted}
  const audits = new Map(); // sku -> [{pass, retracted}]
  for (const ev of events) {
    if (ev.kind === 'barcode') barcodes.set(ev.op, { frame: ev.frame, case: ev.case, retracted: false });
    else if (ev.kind === 'vision') visions.push({ frame: ev.frame, sku: ev.sku, hasDefect: ev.defect != null, retracted: false });
    else if (ev.kind === 'audit') {
      if (!audits.has(ev.sku)) audits.set(ev.sku, []);
      audits.get(ev.sku).push({ pass: ev.pass, retracted: false });
    } else if (ev.kind === 'retract') {
      if (ev.target === 'barcode' && barcodes.has(ev.id)) barcodes.get(ev.id).retracted = true;
      if (ev.target === 'vision') visions.forEach((v, i) => { if (`v${i}` === ev.id) v.retracted = true; });
      if (ev.target === 'audit') {
        for (const list of audits.values()) list.forEach((a) => { if (a.op === ev.id) a.retracted = true; });
      }
    }
  }
  const byCase = new Map();
  for (const b of barcodes.values()) {
    if (b.retracted) continue;
    if (!byCase.has(b.case)) byCase.set(b.case, []);
    byCase.get(b.case).push(b.frame);
  }
  const result = new Map();
  for (const [caseId, frames] of byCase) {
    const joined = visions.filter((v) => !v.retracted && frames.includes(v.frame));
    const skus = [...new Set(joined.map((v) => v.sku))];
    let state;
    if (skus.length > 1) state = 'CONFLICT';
    else if (joined.some((v) => v.hasDefect)) state = 'QUAR';
    else if (skus.length === 1) {
      const list = (audits.get(skus[0]) ?? []).filter((a) => !a.retracted);
      state = list.length && list[list.length - 1].pass ? 'RELEASE' : 'QUAR';
    } else state = 'QUAR';
    result.set(caseId, state);
  }
  return result;
}

function buildEvents(frameCount, caseMask, visionMask, skuMask, auditS0, auditS1) {
  const events = [];
  let ts = 100;
  const step = () => { ts += 10; return ts; }; // all inside window 0, strictly increasing
  for (let f = 0; f < frameCount; f += 1) {
    events.push({ kind: 'barcode', eventTs: step(), frame: f + 1, case: `C${(caseMask >> f) & 1}`, op: `b${f}` });
  }
  for (let f = 0; f < frameCount; f += 1) {
    if ((visionMask >> f) & 1) {
      events.push({
        kind: 'vision', eventTs: step(), frame: f + 1,
        sku: `S${(skuMask >> f) & 1}`, defect: null, hash: HASH_A, op: `v${f}`,
      });
    }
  }
  if (auditS0 !== 'none') events.push({ kind: 'audit', eventTs: step(), sku: 'S0', pass: auditS0 === 'pass', op: 'a0' });
  if (auditS1 !== 'none') events.push({ kind: 'audit', eventTs: step(), sku: 'S1', pass: auditS1 === 'pass', op: 'a1' });
  return events;
}

function assertMatches(events, ctx) {
  const proc = new Processor();
  events.forEach((ev, i) => assert.equal(proc.apply(i, ev), 'applied', `event ${i} late in ${ctx}`));
  const actual = new Map(proc.finalize().map((c) => [c.case, c.state]));
  const expected = referenceStates(events);
  assert.deepEqual(actual, expected, `mismatch for ${ctx}`);
}

const AUDIT_OPTS = ['none', 'pass', 'fail'];

test('acceptance 3: exhaustive enumeration over <=4 frames matches the reference quarantine set', () => {
  let checked = 0;
  for (let n = 1; n <= 4; n += 1) {
    for (let caseMask = 0; caseMask < (1 << n); caseMask += 1) {
      for (let visionMask = 0; visionMask < (1 << n); visionMask += 1) {
        for (let skuMask = 0; skuMask < (1 << n); skuMask += 1) {
          for (const a0 of AUDIT_OPTS) {
            for (const a1 of AUDIT_OPTS) {
              const events = buildEvents(n, caseMask, visionMask, skuMask, a0, a1);
              assertMatches(events, `n=${n} case=${caseMask} vis=${visionMask} sku=${skuMask} a=${a0},${a1}`);
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 30000, `expected a large enumeration, got ${checked}`);
});

test('acceptance 3: deterministic sample of 5-frame scenarios matches the reference', () => {
  // Seeded PRNG (mulberry32) keeps the sample reproducible.
  let seed = 0xC0FFEE;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = 5;
  for (let iter = 0; iter < 3000; iter += 1) {
    const caseMask = Math.floor(rand() * (1 << n));
    const visionMask = Math.floor(rand() * (1 << n));
    const skuMask = Math.floor(rand() * (1 << n));
    const a0 = AUDIT_OPTS[Math.floor(rand() * 3)];
    const a1 = AUDIT_OPTS[Math.floor(rand() * 3)];
    const events = buildEvents(n, caseMask, visionMask, skuMask, a0, a1);
    assertMatches(events, `sample ${iter}`);
  }
});

test('enumeration events stay inside one window and never go late', () => {
  const events = buildEvents(5, 31, 31, 31, 'pass', 'pass');
  assert.ok(events[events.length - 1].eventTs < WINDOW_MS);
});
