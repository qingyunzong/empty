'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Processor, processBytes } = require('../src/processor');
const { start, end, undo, stream, rng } = require('../testlib/helpers');

// Build a random but protocol-valid frame stream: per work order a random
// walk over START/END/UNDO that never violates the state machine, plus
// random duplicates and bounded reordering of frames.
function randomStream(rand) {
  const frames = [];
  const woState = new Map(); // wo -> { records: [{kind, undone}] }
  const wos = ['WO-1', 'WO-2', 'WO-3'];
  let seq = 0;
  const count = 3 + Math.floor(rand() * 10);
  for (let i = 0; i < count; i++) {
    const wo = wos[Math.floor(rand() * wos.length)];
    let st = woState.get(wo);
    if (!st) { st = { records: [] }; woState.set(wo, st); }
    const last = st.records[st.records.length - 1];
    const canEnd = last && last.kind === 'start';
    const canUndo = last && last.kind === 'end' && !last.undone;
    const choices = ['start'];
    if (canEnd) choices.push('end');
    if (canUndo) choices.push('undo');
    const pick = choices[Math.floor(rand() * choices.length)];
    if (pick === 'start') { frames.push(start(wo, seq++)); st.records.push({ kind: 'start' }); }
    else if (pick === 'end') { frames.push(end(wo, seq++)); st.records.push({ kind: 'end', undone: false }); }
    else { frames.push(undo(wo, seq++)); last.undone = true; st.records.push({ kind: 'undo' }); }
  }
  // Random duplicates (retransmissions) inserted after the original.
  const withDups = [];
  for (const f of frames) {
    withDups.push(f);
    if (rand() < 0.3) withDups.push(Buffer.from(f));
  }
  // Bounded reordering: swap adjacent frames with small probability.
  for (let i = 0; i + 1 < withDups.length; i++) {
    if (rand() < 0.15) {
      [withDups[i], withDups[i + 1]] = [withDups[i + 1], withDups[i]];
    }
  }
  return stream(...withDups);
}

function runChunked(bytes, rand, opts) {
  const p = new Processor(opts);
  const events = [];
  let pos = 0;
  while (pos < bytes.length) {
    const n = 1 + Math.floor(rand() * 17); // random chunk sizes incl. half frames
    const r = p.push(bytes.subarray(pos, pos + n));
    events.push(...r.events);
    if (r.error) return { events, error: r.error, exitCode: r.exitCode };
    pos += n;
  }
  const done = p.finish();
  events.push(...done.events);
  if (done.error) return { events, error: done.error, exitCode: done.exitCode };
  return { events, certificate: done.certificate, error: null, exitCode: 0 };
}

// Acceptance 4: random small streams, brute-force replayed under random
// chunkings, always produce identical results.
test('acceptance 4: random streams replay identically across chunkings', () => {
  for (let trial = 0; trial < 200; trial++) {
    const bytes = randomStream(rng(trial * 7919 + 1));
    const timeout = trial % 3 === 0 ? 0 : 5 + (trial % 7);
    const base = processBytes(bytes, { timeout });
    const baseOut = JSON.stringify(base);
    for (let replay = 0; replay < 20; replay++) {
      const got = runChunked(bytes, rng(trial * 31337 + replay * 131 + 7), { timeout });
      assert.equal(JSON.stringify(got), baseOut, `trial ${trial} replay ${replay}`);
    }
  }
});

test('acceptance 4: byte-at-a-time equals one-shot for random streams', () => {
  for (let trial = 0; trial < 50; trial++) {
    const bytes = randomStream(rng(100000 + trial));
    const base = processBytes(bytes, { timeout: 9 });
    const p = new Processor({ timeout: 9 });
    const events = [];
    for (let i = 0; i < bytes.length; i++) {
      events.push(...p.push(bytes.subarray(i, i + 1)).events);
    }
    const done = p.finish();
    events.push(...done.events);
    assert.deepEqual({ events, certificate: done.certificate ?? null, error: done.error ?? null }, {
      events: base.events,
      certificate: base.certificate ?? null,
      error: base.error ?? null,
    }, `trial ${trial}`);
  }
});
