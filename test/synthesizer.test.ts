import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventSynthesizer, type EventEnvelope } from '../src/synthesizer.js';
import {
  ConflictingEventError,
  ConfirmationReadError,
  NoHeldEventError,
  SynthesizerStoppedError,
  WriteOutcomeUnknownError,
} from '../src/errors.js';
import { FaultyConfirmationStore } from './faulty-store.js';

function event(
  id: string,
  predecessors: readonly string[],
  payload: unknown = null,
): EventEnvelope {
  return { id, predecessors, payload };
}

describe('diamond dependency with out-of-order and duplicated arrival', () => {
  //        a
  //       / \
  //      b   c
  //       \ /
  //        d
  const diamond: EventEnvelope[] = [
    event('d', ['b', 'c'], { at: 4 }),
    event('b', ['a'], { at: 2 }),
    event('a', [], { at: 1 }),
    event('c', ['a'], { at: 3 }),
  ];

  it('delivers only after every predecessor is confirmed, in id order', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    // Arrive fully shuffled.
    for (const envelope of [diamond[2]!, diamond[0]!, diamond[3]!, diamond[1]!]) {
      synthesizer.ingest(envelope);
    }

    // Only 'a' (no predecessors) is ready even though b, c, d already arrived.
    assert.equal((await synthesizer.take())?.id, 'a');
    // While held, take keeps returning the same event instead of another one.
    assert.equal((await synthesizer.take())?.id, 'a');
    await synthesizer.confirm();

    // b and c are now both ready; the lexicographically smallest id wins.
    assert.equal((await synthesizer.take())?.id, 'b');
    await synthesizer.confirm();
    assert.equal((await synthesizer.take())?.id, 'c');
    await synthesizer.confirm();

    // d becomes ready only after both direct predecessors are confirmed.
    assert.equal((await synthesizer.take())?.id, 'd');
    await synthesizer.confirm();
    assert.equal(await synthesizer.take(), null);
  });

  it('treats exact duplicates as idempotent re-arrivals', () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    synthesizer.ingest(event('a', [], { x: 1 }));
    assert.doesNotThrow(() => synthesizer.ingest(event('a', [], { x: 1 })));
    synthesizer.ingest(event('m', ['p1', 'p2']));
    // Same predecessor set in a different order, with a repeated id.
    assert.doesNotThrow(() =>
      synthesizer.ingest(event('m', ['p2', 'p1', 'p1'])),
    );
    assert.deepEqual(synthesizer.unconfirmedIds, ['a', 'm']);
  });

  it('rejects the second copy when the same id carries different content', () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    synthesizer.ingest(event('a', ['p'], { v: 1 }));
    assert.throws(
      () => synthesizer.ingest(event('a', ['p'], { v: 2 })),
      ConflictingEventError,
    );
    assert.throws(
      () => synthesizer.ingest(event('a', ['other'], { v: 1 })),
      ConflictingEventError,
    );
    assert.deepEqual(synthesizer.unconfirmedIds, ['a']);
  });

  it('supports explicit release, which allows redelivery with the same id', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    synthesizer.ingest(event('a', [], 'first'));
    synthesizer.ingest(event('b', ['a'], 'second'));

    const held = await synthesizer.take();
    assert.equal(held?.id, 'a');
    await synthesizer.release();
    // b still waits for a's confirmation; a is redelivered with the same id.
    const redelivered = await synthesizer.take();
    assert.equal(redelivered?.id, 'a');
    assert.equal(redelivered?.payload, 'first');
    await synthesizer.confirm();
    assert.equal((await synthesizer.take())?.id, 'b');
    await synthesizer.confirm();
  });

  it('validates envelope structure', () => {
    const synthesizer = new EventSynthesizer(new FaultyConfirmationStore());
    assert.throws(() =>
      synthesizer.ingest({ id: '', predecessors: [], payload: null }),
    );
    assert.throws(() =>
      synthesizer.ingest({
        id: 'x',
        predecessors: [1 as unknown as string],
        payload: null,
      }),
    );
  });
});

describe('confirmation response lost after a durable write', () => {
  it('reads the marker back before redelivery and never redelivers confirmed events', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    synthesizer.ingest(event('a', []));
    synthesizer.ingest(event('b', ['a']));

    assert.equal((await synthesizer.take())?.id, 'a');
    store.loseNextWrites = 1;
    await assert.rejects(
      () => synthesizer.confirm(),
      WriteOutcomeUnknownError,
    );

    // The write actually persisted; the event remains held meanwhile.
    assert.equal(store.hasDurableMarker('a'), true);
    assert.equal(synthesizer.heldId, 'a');

    // take performs the mandated marker read first and discovers confirmation.
    assert.equal((await synthesizer.take())?.id, 'b');
    assert.deepEqual(store.readLog, ['a']);
    assert.deepEqual(synthesizer.confirmedIds, ['a']);

    // a is never redelivered and b now flows normally.
    await synthesizer.confirm();
    assert.equal(await synthesizer.take(), null);
  });

  it('keeps an unconfirmed event held when the write genuinely failed', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    synthesizer.ingest(event('a', []));
    assert.equal((await synthesizer.take())?.id, 'a');
    store.failWrites = true;
    await assert.rejects(
      () => synthesizer.confirm(),
      WriteOutcomeUnknownError,
    );
    assert.equal(store.hasDurableMarker('a'), false);

    // The next take reads the marker; unconfirmed means same-id redelivery.
    store.failWrites = false;
    assert.equal((await synthesizer.take())?.id, 'a');
    assert.deepEqual(store.readLog, ['a']);
    await synthesizer.confirm();
    assert.equal(await synthesizer.take(), null);
  });

  it('release also reconciles an unknown write outcome via a read', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    synthesizer.ingest(event('a', []));
    assert.equal((await synthesizer.take())?.id, 'a');
    store.loseNextWrites = 1;
    await assert.rejects(
      () => synthesizer.confirm(),
      WriteOutcomeUnknownError,
    );

    await synthesizer.release();
    assert.equal(synthesizer.heldId, null);
    assert.deepEqual(synthesizer.confirmedIds, ['a']);
    assert.equal(await synthesizer.take(), null);
  });

  it('throws when confirm or release is called without a held event', async () => {
    const synthesizer = new EventSynthesizer(
      new FaultyConfirmationStore(),
    );
    await assert.rejects(() => synthesizer.confirm(), NoHeldEventError);
    await assert.rejects(() => synthesizer.release(), NoHeldEventError);
  });
});

describe('cycles and missing predecessors in the final report', () => {
  it('reports SCCs and self loops without mistaking missing nodes for cycles', () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);

    // Two-node SCC: p <-> q.
    synthesizer.ingest(event('p', ['q']));
    synthesizer.ingest(event('q', ['p']));
    // Self loop on r.
    synthesizer.ingest(event('r', ['r']));
    // Healthy node blocked by never-arriving predecessors.
    synthesizer.ingest(event('s', ['ghost1', 'ghost2']));
    // Node t only depends on a missing node: it must not look like a cycle.
    synthesizer.ingest(event('t', ['ghost1']));

    const report = synthesizer.finish();
    assert.deepEqual(report.missingPredecessors, ['ghost1', 'ghost2']);
    assert.deepEqual(report.cycles, [['p', 'q'], ['r']]);
  });

  it('reports an empty diagnosis for a complete acyclic graph', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);
    synthesizer.ingest(event('a', []));
    synthesizer.ingest(event('b', ['a']));

    const report = synthesizer.finish();
    assert.deepEqual(report.missingPredecessors, []);
    assert.deepEqual(report.cycles, []);

    await drain(synthesizer);
    assert.equal(await synthesizer.take(), null);
  });

  it('handles a larger SCC embedded among healthy and missing nodes', () => {
    const synthesizer = new EventSynthesizer(
      new FaultyConfirmationStore(),
    );
    // SCC x -> y -> z -> x, plus acyclic node w and a missing predecessor m.
    synthesizer.ingest(event('x', ['y', 'm']));
    synthesizer.ingest(event('y', ['z']));
    synthesizer.ingest(event('z', ['x']));
    synthesizer.ingest(event('w', []));

    const report = synthesizer.finish();
    assert.deepEqual(report.missingPredecessors, ['m']);
    assert.deepEqual(report.cycles, [['x', 'y', 'z']]);
  });
});

describe('recovery ordering after a restart', () => {
  it('reads durable markers before redelivery and preserves delivery order', async () => {
    const store = new FaultyConfirmationStore();
    const first = new EventSynthesizer(store);

    first.ingest(event('a', []));
    first.ingest(event('b', ['a']));
    first.ingest(event('c', ['a']));
    first.ingest(event('d', ['b', 'c']));

    // Confirm a and b before the process dies mid-stream.
    assert.equal((await first.take())?.id, 'a');
    await first.confirm();
    assert.equal((await first.take())?.id, 'b');
    await first.confirm();

    // Fresh instance: events are re-ingested, then markers are reconciled.
    const restarted = new EventSynthesizer(store);
    restarted.ingest(event('d', ['b', 'c']));
    restarted.ingest(event('c', ['a']));
    restarted.ingest(event('b', ['a']));
    restarted.ingest(event('a', []));

    // Recover in an arbitrary order; each id is read at most once.
    await restarted.recover(['d', 'a', 'b', 'c']);
    assert.deepEqual([...store.readLog].sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(restarted.confirmedIds, ['a', 'b']);

    // a and b are not redelivered; c goes before d and d waits for c.
    assert.equal((await restarted.take())?.id, 'c');
    await restarted.confirm();
    assert.equal((await restarted.take())?.id, 'd');
    await restarted.confirm();
    assert.equal(await restarted.take(), null);
  });

  it('stops permanently when a marker read fails, until a new instance recovers', async () => {
    const store = new FaultyConfirmationStore();
    const synthesizer = new EventSynthesizer(store);
    synthesizer.ingest(event('a', []));

    assert.equal((await synthesizer.take())?.id, 'a');
    store.failWrites = true;
    await assert.rejects(
      () => synthesizer.confirm(),
      WriteOutcomeUnknownError,
    );

    // Read failure during reconciliation stops the synthesizer.
    store.failWrites = false;
    store.failReads = true;
    await assert.rejects(() => synthesizer.take(), ConfirmationReadError);
    assert.equal(synthesizer.stopped, true);

    // Every further ingestion and delivery operation is refused.
    assert.throws(
      () => synthesizer.ingest(event('z', [])),
      SynthesizerStoppedError,
    );
    await assert.rejects(
      () => synthesizer.take(),
      SynthesizerStoppedError,
    );
    await assert.rejects(
      () => synthesizer.recover(['a']),
      SynthesizerStoppedError,
    );

    // Storage comes back; a brand-new instance can reconcile and continue.
    store.failReads = false;
    const recovered = new EventSynthesizer(store);
    recovered.ingest(event('a', []));
    await recovered.recover(['a']);
    assert.deepEqual(recovered.confirmedIds, []);
    assert.equal((await recovered.take())?.id, 'a');
    await recovered.confirm();
    assert.equal(await recovered.take(), null);
  });

  it('recovers a lost-response confirmation across an actual instance restart', async () => {
    const store = new FaultyConfirmationStore();
    const first = new EventSynthesizer(store);
    first.ingest(event('a', []));
    first.ingest(event('b', ['a']));

    assert.equal((await first.take())?.id, 'a');
    store.loseNextWrites = 1;
    await assert.rejects(
      () => first.confirm(),
      WriteOutcomeUnknownError,
    );
    // Process restarts before take() could read the marker back.

    const restarted = new EventSynthesizer(store);
    restarted.ingest(event('a', []));
    restarted.ingest(event('b', ['a']));
    await restarted.recover(['a', 'b']);

    // Marker was durable despite the lost response: a is not redelivered.
    assert.deepEqual(restarted.confirmedIds, ['a']);
    assert.equal((await restarted.take())?.id, 'b');
    await restarted.confirm();
    assert.equal(await restarted.take(), null);
  });
});

async function drain(
  synthesizer: EventSynthesizer,
): Promise<EventEnvelope[]> {
  const delivered: EventEnvelope[] = [];
  for (;;) {
    const envelope = await synthesizer.take();
    if (envelope === null) {
      return delivered;
    }
    await synthesizer.confirm();
    delivered.push(envelope);
  }
}
