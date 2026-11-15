import { test } from "node:test";
import assert from "node:assert/strict";
import { WebhookIngestor } from "../src/ingestor.js";
import { MemoryIngestionStore } from "../src/memory-store.js";
import {
  BodyConflictError,
  InvalidSignatureError,
  TransactionFailedError,
  UnknownEndpointError,
} from "../src/errors.js";
import { bodyDigest, signDelivery } from "../src/crypto.js";
import { endpointA, endpointStrict, rotationHeaders, signedHeaders } from "./helpers.js";

const now = 1_700_000_000_000;

function makeIngestor(store = new MemoryIngestionStore()) {
  return {
    store,
    ingestor: new WebhookIngestor([endpointA, endpointStrict], store, { nowMs: () => now }),
  };
}

function request(
  deliveryId: string,
  body: Buffer,
  key = endpointA.keys[0]!,
  timestamp = now,
) {
  return {
    endpointId: endpointA.id,
    deliveryId,
    rawTimestamp: String(timestamp),
    body,
    signatureHeader: signDelivery(key, deliveryId, timestamp, body),
  };
}

test("first delivery is accepted and its receipt binds the committed offset", async () => {
  const { ingestor, store } = makeIngestor();
  const body = Buffer.from('{"n":1}');
  const receipt = await ingestor.ingest(request("del-1", body));

  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.committedOffset, "0");
  assert.equal(receipt.bodyDigest, bodyDigest(body));
  assert.equal(receipt.keyId, "key-2026");

  const stored = store.events(endpointA.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.offset, 0n);
  assert.deepEqual(stored[0]!.body, body);
});

test("the same delivery id with the identical body is idempotent and reuses the offset", async () => {
  const { ingestor, store } = makeIngestor();
  const body = Buffer.from('{"n":2}');
  const first = await ingestor.ingest(request("del-2", body));
  const second = await ingestor.ingest(request("del-2", body));

  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.equal(second.committedOffset, first.committedOffset);
  assert.equal(store.events(endpointA.id).length, 1);

  const record = store.delivery(endpointA.id, "del-2");
  assert.equal(record?.status, "accepted");
  assert.equal(record?.offset?.toString(), first.committedOffset);
});

test("the same delivery id with a different body is a permanent conflict", async () => {
  const { ingestor, store } = makeIngestor();
  await ingestor.ingest(request("del-3", Buffer.from('{"v":1}')));

  await assert.rejects(
    ingestor.ingest(request("del-3", Buffer.from('{"v":2}'))),
    (error: unknown) =>
      error instanceof BodyConflictError &&
      error.statusCode === 409 &&
      error.retryable === false,
  );
  assert.equal(store.events(endpointA.id).length, 1);
});

test("offsets advance per endpoint and are independent across endpoints", async () => {
  const { ingestor, store } = makeIngestor();
  const body = Buffer.from("payload");
  await ingestor.ingest(request("del-a1", body));
  await ingestor.ingest(request("del-a2", body));

  const strictKey = endpointStrict.keys[0]!;
  await ingestor.ingest({
    endpointId: endpointStrict.id,
    deliveryId: "del-b1",
    rawTimestamp: String(now),
    body,
    signatureHeader: signDelivery(strictKey, "del-b1", now, body),
  });

  assert.equal(store.nextOffset(endpointA.id), 2n);
  assert.equal(store.nextOffset(endpointStrict.id), 1n);
  assert.deepEqual(
    store.events(endpointA.id).map((event) => event.offset),
    [0n, 1n],
  );
});

test("a delivery signed by the rotating generation is accepted only once during overlap", async () => {
  const { ingestor, store } = makeIngestor();
  const body = Buffer.from('{"rotate":true}');
  const headers = rotationHeaders(endpointA.keys, "del-rot", now, body);

  const first = await ingestor.ingest({
    endpointId: endpointA.id,
    deliveryId: headers["webhook-delivery-id"]!,
    rawTimestamp: headers["webhook-timestamp"]!,
    body,
    signatureHeader: headers["webhook-signature"]!,
  });
  const second = await ingestor.ingest({
    endpointId: endpointA.id,
    deliveryId: headers["webhook-delivery-id"]!,
    rawTimestamp: headers["webhook-timestamp"]!,
    body,
    signatureHeader: signDelivery(endpointA.keys[1]!, "del-rot", now, body),
  });

  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.equal(second.committedOffset, first.committedOffset);
  assert.equal(store.events(endpointA.id).length, 1);
});

test("a rolled-back transaction leaves no state and the same delivery retries successfully", async () => {
  let failNextCommit = true;
  const store = new MemoryIngestionStore({
    beforeCommit: () => {
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error("simulated database deadlock");
      }
    },
  });
  const { ingestor } = makeIngestor(store);
  const body = Buffer.from('{"retry":true}');

  await assert.rejects(
    ingestor.ingest(request("del-retry", body)),
    (error: unknown) =>
      error instanceof TransactionFailedError &&
      error.retryable === true &&
      error.statusCode === 503,
  );
  assert.equal(store.events(endpointA.id).length, 0);
  assert.equal(store.delivery(endpointA.id, "del-retry"), null);
  assert.equal(store.nextOffset(endpointA.id), 0n);

  const retry = await ingestor.ingest(request("del-retry", body));
  assert.equal(retry.status, "accepted");
  assert.equal(retry.committedOffset, "0");
  assert.equal(store.events(endpointA.id).length, 1);
});

test("an unsigned or badly signed request never touches storage", async () => {
  const { ingestor, store } = makeIngestor();
  const body = Buffer.from("unsigned");
  await assert.rejects(
    ingestor.ingest({
      endpointId: endpointA.id,
      deliveryId: "del-bad",
      rawTimestamp: String(now),
      body,
      signatureHeader: signDelivery(endpointA.keys[0]!, "del-bad", now, Buffer.from("other")),
    }),
    InvalidSignatureError,
  );
  assert.equal(store.events(endpointA.id).length, 0);
});

test("unknown endpoints are rejected without storage side effects", async () => {
  const { ingestor } = makeIngestor();
  await assert.rejects(
    ingestor.ingest({ ...request("del-x", Buffer.from("b")), endpointId: "nope" }),
    UnknownEndpointError,
  );
});

test("an expired timestamp is rejected even though the mac is valid", async () => {
  const { ingestor } = makeIngestor();
  const body = Buffer.from("late");
  const stale = now - endpointStrict.timestampToleranceMs - 1;
  const key = endpointStrict.keys[0]!;
  await assert.rejects(
    ingestor.ingest({
      endpointId: endpointStrict.id,
      deliveryId: "del-late",
      rawTimestamp: String(stale),
      body,
      signatureHeader: signDelivery(key, "del-late", stale, body),
    }),
    /tolerance/,
  );
});

test("concurrent first attempts for one delivery id resolve to a single committed event", async () => {
  const { ingestor, store } = makeIngestor();
  const body = Buffer.from('{"concurrent":true}');
  const results = await Promise.all([
    ingestor.ingest(request("del-conc", body)),
    ingestor.ingest(request("del-conc", body)),
  ]);

  const statuses = results.map((receipt) => receipt.status).sort();
  assert.deepEqual(statuses, ["accepted", "duplicate"]);
  assert.equal(results[0]!.committedOffset, results[1]!.committedOffset);
  assert.equal(store.events(endpointA.id).length, 1);
});

test("signedHeaders helper produces an envelope the ingestor accepts", async () => {
  const { ingestor } = makeIngestor();
  const body = Buffer.from('{"helper":true}');
  const headers = signedHeaders(endpointA.keys[0]!, "del-help", now, body);
  const receipt = await ingestor.ingest({
    endpointId: endpointA.id,
    deliveryId: headers["webhook-delivery-id"]!,
    rawTimestamp: headers["webhook-timestamp"]!,
    body,
    signatureHeader: headers["webhook-signature"]!,
  });
  assert.equal(receipt.committedOffset, "0");
});
