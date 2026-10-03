import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError } from '../src/ledger.js';
import { mulberry32 } from '../testutil/helpers.mjs';

const INSTITUTIONS = ['A', 'B', 'C', 'D'];

function randomEvents(rand, count) {
  const events = INSTITUTIONS.map((id) => ({ type: 'add_institution', id }));
  const versions = new Map();
  for (let k = 0; k < count; k += 1) {
    const pick = rand();
    const from = INSTITUTIONS[Math.floor(rand() * INSTITUTIONS.length)];
    let to = INSTITUTIONS[Math.floor(rand() * INSTITUTIONS.length)];
    if (to === from) to = INSTITUTIONS[(INSTITUTIONS.indexOf(from) + 1) % INSTITUTIONS.length];
    const id = `i${Math.floor(rand() * 10)}`;
    if (pick < 0.55) {
      const current = versions.get(id) ?? 0;
      const roll = rand();
      const version = roll < 0.5 ? current + 1 : 1 + Math.floor(rand() * (current + 2));
      events.push({
        type: 'submit',
        id,
        version,
        from,
        to,
        amount: 1 + Math.floor(rand() * 1_000_000),
      });
    } else if (pick < 0.8) {
      events.push({ type: 'revoke', id });
    } else if (pick < 0.9) {
      events.push({ type: 'commit' });
    } else if (pick < 0.95) {
      events.push({ type: 'depends', from, to });
    } else {
      events.push({ type: 'undepends', from, to });
    }
  }
  return events;
}

function applyBoth(events) {
  const incremental = new Ledger();
  const fresh = new Ledger();
  for (const event of events) {
    let incErr = null;
    let freshErr = null;
    const netsBefore = incremental.nets;
    try {
      incremental.applyEvent(event);
    } catch (err) {
      incErr = err;
    }
    try {
      fresh.applyEvent(event);
    } catch (err) {
      freshErr = err;
    }
    assert.equal(incErr?.code ?? null, freshErr?.code ?? null, `error mismatch on ${JSON.stringify(event)}`);
    if (incErr) {
      assert.ok(incErr instanceof LedgerError);
      assert.deepEqual(incremental.nets, netsBefore, 'failed event must not change nets');
      continue;
    }
    // Incremental graph result must equal the naive full recompute oracle.
    assert.deepEqual(incremental.nets, incremental.naiveNets(), `oracle mismatch on ${JSON.stringify(event)}`);
    assert.deepEqual(incremental.nets, fresh.nets);
    assert.equal(incremental.certTip, fresh.certTip);
  }
  return incremental;
}

test('random small-scale event streams match naive full recompute at every step', () => {
  for (const seed of [1, 7, 42, 1337, 20261004]) {
    const rand = mulberry32(seed);
    const events = randomEvents(rand, 300);
    const ledger = applyBoth(events);
    // Final deterministic recompute from the event log must agree too.
    const replayed = Ledger.replay(ledger.log);
    assert.equal(replayed.certTip, ledger.certTip);
    assert.deepEqual(replayed.nets, ledger.nets);
  }
});

test('exhaustive enumeration of short event sequences matches naive oracle', () => {
  const alphabet = [
    { type: 'add_institution', id: 'A' },
    { type: 'add_institution', id: 'B' },
    { type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 5 },
    { type: 'submit', id: 'i1', version: 2, from: 'A', to: 'B', amount: 7 },
    { type: 'revoke', id: 'i1' },
    { type: 'commit' },
  ];
  const LENGTH = 4;
  const total = alphabet.length ** LENGTH;
  const indices = new Array(LENGTH).fill(0);
  for (let seq = 0; seq < total; seq += 1) {
    let n = seq;
    for (let pos = 0; pos < LENGTH; pos += 1) {
      indices[pos] = n % alphabet.length;
      n = Math.floor(n / alphabet.length);
    }
    const events = indices.map((i) => alphabet[i]);
    const ledger = new Ledger();
    for (const event of events) {
      try {
        ledger.applyEvent(event);
      } catch (err) {
        assert.ok(err instanceof LedgerError);
        continue;
      }
      assert.deepEqual(ledger.nets, ledger.naiveNets(), `oracle mismatch in sequence ${seq}`);
    }
    // Deterministic recompute from scratch must match the incremental run.
    const replayed = new Ledger();
    for (const event of ledger.log) replayed.applyEvent(event);
    assert.equal(replayed.certTip, ledger.certTip, `certificate mismatch in sequence ${seq}`);
  }
});
