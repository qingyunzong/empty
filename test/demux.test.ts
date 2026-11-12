import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Demultiplexer,
  DemuxError,
  RespProtocolError,
  type Delivery,
} from "../index.js";
import { asTruncated, bytes } from "./helpers.js";

function deliveries(
  demux: Demultiplexer<string>,
): Array<Delivery<string>> {
  const result: Array<Delivery<string>> = [];
  while (true) {
    const delivery = demux.next();
    if (delivery === null) {
      return result;
    }
    result.push(delivery);
  }
}

test("normal responses match registration order across an interleaved push", () => {
  const demux = new Demultiplexer<string>();
  demux.register("request-a");
  demux.register("request-b");
  demux.pushBytes(
    bytes(
      "|1\r\n+tag\r\n+a\r\n",
      "+a\r\n",
      "|1\r\n+push\r\n+yes\r\n",
      ">2\r\n+notice\r\n:1\r\n",
      "-ERR b\r\n",
    ),
  );
  const got = deliveries(demux);
  assert.deepStrictEqual(
    got.map((item) => item.disposition),
    ["matched", "push", "matched"],
  );
  assert.equal(got[0]!.ticket, "request-a");
  assert.equal(got[1]!.ticket, null);
  assert.equal(got[2]!.ticket, "request-b");
  assert.equal(demux.pendingCount, 0);
  assert.equal(demux.finish().clean, true);
});

test("push attributes stay on the push; response attributes stay on the response", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  demux.pushBytes(
    bytes(
      "|1\r\n+response-tag\r\n+x\r\n",
      "+OK\r\n",
      "|1\r\n+push-tag\r\n+y\r\n",
      ">1\r\n+payload\r\n",
    ),
  );
  const got = deliveries(demux);
  assert.equal(got[0]!.message.type, "value");
  assert.equal(got[0]!.message.attributes.length, 1);
  assert.equal(got[1]!.message.type, "push");
  assert.equal(got[1]!.message.attributes.length, 1);
  assert.equal(got[1]!.message.type === "push" ? got[1]!.message.values.length : 0, 1);
});

test("push alone does not consume a ticket", () => {
  const demux = new Demultiplexer<string>();
  demux.register("waiting");
  demux.pushBytes(bytes(">1\r\n+pushed\r\n"));
  const first = demux.next();
  assert.equal(first?.disposition, "push");
  assert.equal(demux.pendingCount, 1);
  assert.equal(demux.stateOf("waiting"), "waiting");
});

test("cancelled first request leaves a tombstone instead of shifting", () => {
  const demux = new Demultiplexer<string>();
  demux.register("first");
  demux.register("second");
  demux.cancel("first");
  demux.pushBytes(bytes("+first-response\r\n+second-response\r\n"));
  const got = deliveries(demux);
  assert.deepStrictEqual(
    got.map((item) => item.disposition),
    ["discarded", "matched"],
  );
  assert.equal(got[0]!.ticket, "first");
  assert.equal(got[1]!.ticket, "second");
  assert.equal(
    got[0]!.message.type === "value" ? got[0]!.message.value.type : "",
    "simple-string",
  );
  assert.equal(demux.stateOf("first"), "completed");
  assert.equal(demux.stateOf("second"), "completed");
});

test("a normal simple error consumes the cancelled tombstone", () => {
  const demux = new Demultiplexer<string>();
  demux.register("first");
  demux.register("second");
  demux.cancel("first");
  demux.pushBytes(bytes("-ERR cancelled\r\n+second\r\n"));
  const got = deliveries(demux);
  assert.equal(got[0]!.disposition, "discarded");
  assert.equal(got[0]!.ticket, "first");
  assert.equal(
    got[0]!.message.type === "value" ? got[0]!.message.value.type : "",
    "simple-error",
  );
  assert.equal(got[1]!.disposition, "matched");
  assert.equal(got[1]!.ticket, "second");
});

test("error and null responses consume tickets; no ticket yields unsolicited", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  demux.register("b");
  demux.pushBytes(bytes("_\r\n-ERR nope\r\n"));
  const got = deliveries(demux);
  assert.equal(got[0]!.disposition, "matched");
  assert.equal(got[1]!.disposition, "matched");
  assert.equal(got.length, 2);
  assert.equal(demux.pendingCount, 0);

  demux.pushBytes(bytes("+unsolicited\r\n_\r\n"));
  const extra = deliveries(demux);
  assert.deepStrictEqual(
    extra.map((item) => item.disposition),
    ["unsolicited", "unsolicited"],
  );
  assert.equal(extra[0]!.ticket, null);
  assert.equal(extra[1]!.ticket, null);
});

test("duplicate tickets are rejected without changing the queue", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  assert.throws(
    () => demux.register("a"),
    (error: unknown) =>
      error instanceof DemuxError && error.code === "duplicate-ticket",
  );
  demux.register("b");
  demux.pushBytes(bytes("+one\r\n+two\r\n"));
  const got = deliveries(demux);
  assert.equal(got[0]!.ticket, "a");
  assert.equal(got[1]!.ticket, "b");

  assert.throws(
    () => demux.register("a"),
    (error: unknown) =>
      error instanceof DemuxError && error.code === "duplicate-ticket",
  );
  assert.equal(demux.pendingCount, 0);
});

test("cancel rejects unknown, already-cancelled, and completed tickets without mutation", () => {
  const demux = new Demultiplexer<string>();
  assert.throws(
    () => demux.cancel("unknown"),
    (error: unknown) =>
      error instanceof DemuxError && error.code === "unknown-ticket",
  );
  assert.equal(demux.pendingCount, 0);

  demux.register("a");
  demux.cancel("a");
  assert.equal(demux.stateOf("a"), "discarded");
  assert.equal(demux.pendingCount, 1);
  assert.throws(
    () => demux.cancel("a"),
    (error: unknown) =>
      error instanceof DemuxError && error.code === "ticket-not-pending",
  );
  assert.equal(demux.pendingCount, 1);
  assert.equal(demux.stateOf("a"), "discarded");

  demux.pushBytes(bytes("+response\r\n"));
  assert.equal(demux.next()?.disposition, "discarded");
  assert.equal(demux.stateOf("a"), "completed");
  assert.throws(
    () => demux.cancel("a"),
    (error: unknown) =>
      error instanceof DemuxError && error.code === "ticket-not-pending",
  );
  assert.equal(demux.pendingCount, 0);
});

test("unknown cancellation does not disturb a waiting position", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  assert.throws(
    () => demux.cancel("missing"),
    (error: unknown) =>
      error instanceof DemuxError && error.code === "unknown-ticket",
  );
  demux.pushBytes(bytes("+value\r\n"));
  const got = demux.next();
  assert.equal(got?.disposition, "matched");
  assert.equal(got?.ticket, "a");
});

test("a half line does not complete or consume a ticket", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  demux.pushBytes(bytes("+O"));
  assert.equal(demux.next(), null);
  assert.equal(demux.stateOf("a"), "waiting");
  assert.equal(demux.pendingCount, 1);
  demux.pushBytes(bytes("K\r\n"));
  const got = demux.next();
  assert.equal(got?.disposition, "matched");
  assert.equal(got?.ticket, "a");
});

test("an unattached attribute EOF leaves the ticket waiting", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  demux.pushBytes(bytes("|1\r\n+k\r\n+v\r\n"));
  assert.equal(demux.next(), null);
  const finish = asTruncated(demux.finish());
  assert.equal(finish.reason, "orphan-attributes");
  assert.equal(finish.pendingAttributes, true);
  assert.equal(demux.stateOf("a"), "waiting");
  assert.equal(demux.pendingCount, 1);
});

test("a permanent fault does not consume the current ticket", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  demux.register("b");
  demux.pushBytes(bytes("+a-response\r\n!bad-frame\r\n"));
  assert.equal(demux.next()?.ticket, "a");
  assert.throws(
    () => demux.next(),
    (error: unknown) =>
      error instanceof RespProtocolError && error.code === "unsupported-type",
  );
  assert.equal(demux.stateOf("b"), "waiting");
  assert.equal(demux.pendingCount, 1);
});

test("queue advances only when a complete normal message is consumed", () => {
  const demux = new Demultiplexer<string>();
  demux.register("a");
  demux.register("b");
  demux.pushBytes(bytes("+one\r\n"));
  assert.equal(demux.pendingCount, 2);
  assert.equal(demux.next()?.ticket, "a");
  assert.equal(demux.pendingCount, 1);
  assert.equal(demux.stateOf("a"), "completed");
  assert.equal(demux.stateOf("b"), "waiting");
});

test("ticket results and push ordering are stable at every byte boundary", () => {
  const wire = bytes(
    "|1\r\n+tag\r\n+first\r\n",
    "+r1\r\n",
    "|1\r\n+push-tag\r\n+yes\r\n",
    ">1\r\n+notice\r\n",
    "-ERR cancelled-slot\r\n",
    "_\r\n",
    "+extra\r\n",
  );

  function makeDemux(): Demultiplexer<string> {
    const demux = new Demultiplexer<string>();
    demux.register("first");
    demux.register("cancelled");
    demux.register("third");
    demux.cancel("cancelled");
    return demux;
  }

  const full = makeDemux();
  full.pushBytes(wire);
  const expected = deliveries(full);
  assert.deepStrictEqual(
    expected.map((item) => [item.disposition, item.ticket]),
    [
      ["matched", "first"],
      ["push", null],
      ["discarded", "cancelled"],
      ["matched", "third"],
      ["unsolicited", null],
    ],
  );
  assert.equal(full.finish().clean, true);

  for (let split = 0; split <= wire.length; split += 1) {
    const demux = makeDemux();
    const got: Array<Delivery<string>> = [];
    demux.pushBytes(wire.slice(0, split));
    got.push(...deliveries(demux));
    demux.pushBytes(wire.slice(split));
    got.push(...deliveries(demux));
    assert.deepStrictEqual(got, expected, `demux split at ${split}`);
    assert.equal(demux.finish().clean, true, `finish split at ${split}`);
  }
});
