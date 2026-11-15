import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bodyDigest,
  buildSignatureHeader,
  canonicalString,
  parseSignatureHeader,
  parseTimestampHeader,
  signDelivery,
  verifySignature,
} from "../src/crypto.js";
import {
  InvalidSignatureError,
  MalformedEnvelopeError,
  TimestampSkewError,
  UnknownKeyError,
} from "../src/errors.js";
import { endpointA, endpointStrict } from "./helpers.js";

const body = Buffer.from(JSON.stringify({ event: "order.created", id: 42 }), "utf8");
const deliveryId = "del_001";
const now = 1_700_000_000_000;

test("bodyDigest is the SHA-256 hex of the raw body", () => {
  assert.equal(bodyDigest(body), createHash("sha256").update(body).digest("hex"));
});

test("canonical string binds delivery id, timestamp and exact body bytes", () => {
  const canonical = canonicalString(deliveryId, now, body);
  assert.deepEqual(
    canonical,
    Buffer.concat([Buffer.from(`${deliveryId}.${now}.`, "utf8"), body]),
  );
});

test("a signature produced by a configured key verifies and reports its generation", () => {
  const header = signDelivery(endpointA.keys[0]!, deliveryId, now, body);
  const result = verifySignature(endpointA, deliveryId, String(now), body, header, now);
  assert.deepEqual(result, { keyId: "key-2026", timestamp: now });
});

test("the previous generation is accepted inside the rotation overlap window", () => {
  const header = signDelivery(endpointA.keys[1]!, deliveryId, now, body);
  const result = verifySignature(endpointA, deliveryId, String(now), body, header, now);
  assert.equal(result.keyId, "key-2025");
});

test("a header carrying both generations verifies once against the current key", () => {
  const header = buildSignatureHeader(endpointA.keys, deliveryId, now, body);
  assert.equal(parseSignatureHeader(header).length, 2);
  const result = verifySignature(endpointA, deliveryId, String(now), body, header, now);
  assert.equal(result.keyId, "key-2026");
});

test("timestamps outside the tolerance window are rejected before mac checks", () => {
  const header = signDelivery(endpointStrict.keys[0]!, deliveryId, now, body);
  assert.throws(
    () =>
      verifySignature(
        endpointStrict,
        deliveryId,
        String(now),
        body,
        header,
        now + endpointStrict.timestampToleranceMs + 1,
      ),
    (error: unknown) =>
      error instanceof TimestampSkewError &&
      error.code === "TIMESTAMP_SKEW" &&
      error.retryable === false,
  );
});

test("a timestamp at the exact tolerance boundary is accepted", () => {
  const header = signDelivery(endpointStrict.keys[0]!, deliveryId, now, body);
  const result = verifySignature(
    endpointStrict,
    deliveryId,
    String(now),
    body,
    header,
    now + endpointStrict.timestampToleranceMs,
  );
  assert.equal(result.keyId, "k1");
});

test("a tampered body fails signature verification", () => {
  const header = signDelivery(endpointA.keys[0]!, deliveryId, now, body);
  const tampered = Buffer.concat([body, Buffer.from("x")]);
  assert.throws(
    () => verifySignature(endpointA, deliveryId, String(now), tampered, header, now),
    InvalidSignatureError,
  );
});

test("a signature computed with an unregistered key is rejected as unknown key", () => {
  const header = signDelivery({ id: "retired", secret: "old" }, deliveryId, now, body);
  assert.throws(
    () => verifySignature(endpointA, deliveryId, String(now), body, header, now),
    UnknownKeyError,
  );
});

test("a swapped delivery id invalidates the signature", () => {
  const header = signDelivery(endpointA.keys[0]!, deliveryId, now, body);
  assert.throws(
    () => verifySignature(endpointA, "del_other", String(now), body, header, now),
    InvalidSignatureError,
  );
});

test("malformed signature headers and timestamps raise envelope errors", () => {
  assert.throws(() => parseSignatureHeader("not-a-token"), MalformedEnvelopeError);
  assert.throws(() => parseSignatureHeader("v1,kid"), MalformedEnvelopeError);
  assert.throws(() => parseTimestampHeader("1700000000000.5"), MalformedEnvelopeError);
  assert.throws(() => parseTimestampHeader("-1"), MalformedEnvelopeError);
  assert.throws(
    () => verifySignature(endpointA, deliveryId, String(now), body, "   ", now),
    MalformedEnvelopeError,
  );
});
