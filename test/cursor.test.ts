import assert from "node:assert/strict";
import test from "node:test";

import {
  PulsarCursor,
  compareMessageIds,
  createPulsarMessageId,
} from "../index.ts";

const id = (entry: number, batchIndex = -1, ledger = 1) =>
  createPulsarMessageId(ledger, entry, batchIndex);

const plain = (value: { ledgerId: bigint; entryId: bigint; batchIndex: number } | null) =>
  value === null
    ? null
    : {
        ledgerId: value.ledgerId.toString(),
        entryId: value.entryId.toString(),
        batchIndex: value.batchIndex,
      };

test("orders ledger, entry and batch index", () => {
  assert.equal(compareMessageIds(id(2, 0), id(2, -1)), 1);
  assert.equal(compareMessageIds(id(2, 1, 2), id(2, 1, 2)), 0);
  assert.equal(compareMessageIds(id(3, -1), id(2, 99)), 1);
});

test("individual acks advance only the contiguous prefix", () => {
  const cursor = new PulsarCursor();
  cursor.acknowledge(id(2));
  assert.deepEqual(plain(cursor.cursor), plain(id(2)));

  cursor.acknowledge(id(4));
  assert.deepEqual(plain(cursor.cursor), plain(id(2)));
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(3)));
  assert.deepEqual(plain(cursor.pending?.to ?? null), plain(id(4)));

  cursor.acknowledge(id(3));
  assert.deepEqual(plain(cursor.cursor), plain(id(4)));
  assert.equal(cursor.pending, null);
});

test("a batch does not move the durable cursor until every child is terminal", () => {
  const cursor = new PulsarCursor();
  cursor.acknowledge(id(1));

  cursor.acknowledge({ ledgerId: 1n, entryId: 2n, batchIndex: 0, batchSize: 3 });
  cursor.acknowledge({ ledgerId: 1n, entryId: 2n, batchIndex: 2, batchSize: 3 });
  assert.deepEqual(plain(cursor.cursor), plain(id(1)));
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(2, 1)));
  assert.deepEqual(plain(cursor.pending?.to ?? null), plain(id(2, 2)));

  const result = cursor.acknowledge({ ledgerId: 1n, entryId: 2n, batchIndex: 1, batchSize: 3 });
  assert.equal(result.advanced, true);
  assert.deepEqual(plain(cursor.cursor), plain(id(2, 2)));
  assert.equal(cursor.pending, null);
});

test("cumulative ack inside a batch leaves the suffix unresolved", () => {
  const cursor = new PulsarCursor();
  cursor.acknowledgeCumulative({ ledgerId: 1n, entryId: 2n, batchIndex: 1, batchSize: 4 });
  assert.equal(cursor.cursor, null);
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(2, 2)));
  assert.deepEqual(plain(cursor.pending?.to ?? null), plain(id(2, 3)));

  cursor.acknowledge(id(2, 3, 1));
  cursor.acknowledge(id(2, 2, 1));
  assert.deepEqual(plain(cursor.cursor), plain(id(2, 3)));
  assert.equal(cursor.pending, null);
});

test("a denial rolls the durable cursor back and is reported as pending", () => {
  const cursor = new PulsarCursor();
  cursor.acknowledge(id(1));
  cursor.acknowledge(id(2));
  cursor.acknowledge(id(3));
  assert.deepEqual(plain(cursor.cursor), plain(id(3)));

  cursor.negativeAcknowledge(id(2));
  assert.deepEqual(plain(cursor.cursor), plain(id(1)));
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(2)));
  assert.deepEqual(plain(cursor.pending?.to ?? null), plain(id(3)));
  assert.equal(cursor.isAcknowledged(id(2)), false);

  cursor.acknowledge(id(2));
  assert.deepEqual(plain(cursor.cursor), plain(id(3)));
  assert.equal(cursor.pending, null);
});

test("redelivery creates a new generation and rejects the old token", () => {
  const cursor = new PulsarCursor();
  const first = cursor.observe(id(1));
  cursor.acknowledge(id(1), { token: first.token });
  assert.deepEqual(plain(cursor.cursor), plain(id(1)));

  const replay = cursor.redeliver(id(1));
  assert.equal(replay.redelivered, true);
  assert.deepEqual(plain(cursor.cursor), null);
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(1)));

  const stale = cursor.acknowledge(id(1), { token: first.token });
  assert.equal(stale.accepted, false);
  assert.equal(stale.stale, true);
  assert.equal(cursor.isAcknowledged(id(1)), false);

  const fresh = cursor.acknowledge(id(1), { token: replay.token });
  assert.equal(fresh.accepted, true);
  assert.deepEqual(plain(cursor.cursor), plain(id(1)));
  assert.equal(cursor.pending, null);
});

test("rollback reopens the target range and invalidates older ack tokens", () => {
  const cursor = new PulsarCursor();
  const first = cursor.observe(id(1));
  const second = cursor.observe(id(2));
  cursor.acknowledge(id(1), { token: first.token });
  cursor.acknowledge(id(2), { token: second.token });

  cursor.rollback(id(2));
  assert.deepEqual(plain(cursor.cursor), plain(id(1)));
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(2)));

  const stale = cursor.acknowledge(id(2), { token: second.token });
  assert.equal(stale.stale, true);
  assert.equal(cursor.isAcknowledged(id(2)), false);

  cursor.acknowledge(id(2));
  assert.deepEqual(plain(cursor.cursor), plain(id(2)));
});

test("topic truncation advances over removed entries and clamps pending", () => {
  const cursor = new PulsarCursor();
  cursor.acknowledge(id(1));
  cursor.observe(id(3));
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(2)));

  cursor.truncate(id(2));
  assert.deepEqual(plain(cursor.cursor), plain(id(2)));
  assert.deepEqual(plain(cursor.pending?.from ?? null), plain(id(3)));

  cursor.truncate(id(3));
  assert.deepEqual(plain(cursor.cursor), plain(id(3)));
  assert.equal(cursor.pending, null);
});

test("truncating a whole batch does not leave missing children behind", () => {
  const cursor = new PulsarCursor();
  cursor.observe({ ledgerId: 1n, entryId: 5n, batchIndex: 0, batchSize: 4 });
  cursor.truncate({ ledgerId: 1n, entryId: 5n });
  assert.deepEqual(plain(cursor.cursor), plain(id(5, 3)));
  assert.equal(cursor.pending, null);
});

test("snapshots round-trip cursor, batch state and pending range", () => {
  const cursor = new PulsarCursor();
  cursor.acknowledge(id(1));
  cursor.observe({ ledgerId: 1n, entryId: 2n, batchIndex: 0, batchSize: 3 });
  cursor.acknowledge({ ledgerId: 1n, entryId: 2n, batchIndex: 0, batchSize: 3 });

  const encoded = cursor.serialize();
  const restored = PulsarCursor.deserialize(encoded);
  assert.deepEqual(plain(restored.cursor), plain(cursor.cursor));
  assert.deepEqual(plain(restored.pending?.from ?? null), plain(cursor.pending?.from ?? null));

  restored.acknowledge({ ledgerId: 1n, entryId: 2n, batchIndex: 1, batchSize: 3 });
  restored.acknowledge({ ledgerId: 1n, entryId: 2n, batchIndex: 2, batchSize: 3 });
  assert.deepEqual(plain(restored.cursor), plain(id(2, 2)));
});

test("the persistence hook fires only when the durable cursor moves", () => {
  const persisted: Array<string | null> = [];
  const cursor = new PulsarCursor({
    onPersist: (position) => persisted.push(position?.entryId.toString() ?? null),
  });

  cursor.acknowledge({ ledgerId: 1n, entryId: 1n, batchIndex: 0, batchSize: 2 });
  assert.equal(persisted.length, 0);

  cursor.acknowledge({ ledgerId: 1n, entryId: 1n, batchIndex: 1, batchSize: 2 });
  assert.deepEqual(persisted, ["1"]);
});
