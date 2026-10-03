import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffStores, emptyStore, ingestEvents } from '../src/store.js';

const ev = (id, device, ts, state, node, clock) => ({ id, device, ts, state, node, clock });

describe('store ingest', () => {
  it('is idempotent by event id', () => {
    const store = emptyStore();
    const event = ev('e1', 'A', 10, 'down', 'n1', { n1: 1 });
    const first = ingestEvents(store, [event]);
    const second = ingestEvents(store, [event, { ...event, id: 'e1' }]);
    assert.deepEqual(first.accepted, ['e1']);
    assert.deepEqual(second.accepted, []);
    assert.deepEqual(second.duplicates, ['e1', 'e1']);
    assert.equal(store.events.length, 1);
    assert.equal(store.version, 1);
  });

  it('records versioned corrections for late events', () => {
    const store = emptyStore();
    ingestEvents(store, [ev('e1', 'A', 30, 'up', 'n1', { n1: 1 })]);
    const late = ingestEvents(store, [ev('e2', 'A', 10, 'down', 'n2', { n2: 1 })]);
    assert.equal(late.version, 2);
    assert.deepEqual(late.corrections, [
      { version: 2, eventId: 'e2', device: 'A', reason: 'late-event' },
    ]);
    assert.equal(store.corrections.length, 1);
  });

  it('does not flag events for other devices as late', () => {
    const store = emptyStore();
    ingestEvents(store, [ev('e1', 'A', 30, 'up', 'n1', { n1: 1 })]);
    const result = ingestEvents(store, [ev('e2', 'B', 10, 'down', 'n2', { n2: 1 })]);
    assert.deepEqual(result.corrections, []);
  });
});

describe('store diff', () => {
  it('reports added events and corrections between snapshots', () => {
    const prev = emptyStore();
    ingestEvents(prev, [ev('e1', 'A', 30, 'up', 'n1', { n1: 1 })]);
    const next = JSON.parse(JSON.stringify(prev));
    ingestEvents(next, [ev('e2', 'A', 10, 'down', 'n2', { n2: 1 })]);
    const diff = diffStores(prev, next);
    assert.equal(diff.versionFrom, 1);
    assert.equal(diff.versionTo, 2);
    assert.deepEqual(diff.addedEvents.map((e) => e.id), ['e2']);
    assert.deepEqual(diff.addedCorrections.map((c) => c.eventId), ['e2']);
  });
});
