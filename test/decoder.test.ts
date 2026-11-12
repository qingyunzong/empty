import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Decoder,
  RespProtocolError,
  decodeReference,
  type DecoderLimitOverrides,
  type TruncationReason,
} from "../index.js";
import { validFixtures } from "./fixtures.js";
import {
  asPushMessage,
  asTruncated,
  asValueMessage,
  bytes,
  decodeAtEveryBoundary,
  drain,
  text,
} from "./helpers.js";

function expectFault(
  input: Uint8Array,
  code: string,
  limits: DecoderLimitOverrides = {},
): void {
  const decoder = new Decoder(limits);
  decoder.pushBytes(input);
  let thrown: unknown;
  try {
    while (decoder.next() !== null) {
      // Drain complete messages so a later faulty frame is still observed.
    }
  } catch (error) {
    thrown = error;
  }
  assert.ok(
    thrown instanceof RespProtocolError && thrown.code === code,
    `expected protocol error ${code}`,
  );
  assert.throws(
    () => decoder.next(),
    (error: unknown) =>
      error instanceof RespProtocolError && error.code === code,
    "faults are permanent",
  );
}

function finishReason(input: Uint8Array, limits: DecoderLimitOverrides = {}) {
  const decoder = new Decoder(limits);
  decoder.pushBytes(input);
  assert.equal(decoder.next(), null);
  return asTruncated(decoder.finish());
}

test("valid fixtures match the independent one-shot reference at every boundary", () => {
  for (const fixture of validFixtures) {
    const reference = decodeReference(fixture.wire, fixture.limits);
    assert.ok(reference.messages.length > 0);
    decodeAtEveryBoundary(fixture.wire, fixture.limits);
  }
});

test("blob chunks preserve physical provenance but expose joined logical bytes", () => {
  const input = bytes(
    "$?\r\n",
    ";5\r\n>\r\nab\r\n",
    ";4\r\nx\r\ny\r\n",
    ";0\r\n",
  );
  const decoder = new Decoder();
  decoder.pushBytes(input);
  const message = asValueMessage(decoder.next());
  assert.equal(message.value.type, "blob");
  if (message.value.type === "blob") {
    assert.deepStrictEqual(message.value.chunks, [
      bytes(">\r\nab"),
      bytes("x\r\ny"),
    ]);
    assert.deepStrictEqual(message.value.value, bytes(">\r\nabx\r\ny"));
    assert.equal(message.value.chunks[0]!.length, 5);
  }
  assert.deepStrictEqual(
    decoder.finish(),
    { clean: true, ok: true, pendingMessages: 0 },
  );
});

test("map array/blob keys and duplicate pairs remain a tree", () => {
  const decoder = new Decoder();
  decoder.pushBytes(
    bytes(
      "%4\r\n",
      "*1\r\n+key\r\n+value\r\n",
      "$3\r\nblb\r\n:7\r\n",
      "+dup\r\n:1\r\n",
      "+dup\r\n:2\r\n",
    ),
  );
  const message = asValueMessage(decoder.next());
  assert.equal(message.value.type, "map");
  if (message.value.type === "map") {
    assert.equal(message.value.value.length, 4);
    assert.equal(message.value.value[0]!.key.type, "array");
    assert.equal(message.value.value[1]!.key.type, "blob");
    assert.equal(message.value.value[2]!.key.type, "simple-string");
    assert.deepStrictEqual(
      message.value.value.map((pair) => pair.key.type),
      ["array", "blob", "simple-string", "simple-string"],
    );
    assert.equal(message.value.value[2]!.value.type, "integer");
  }
});

test("attribute ownership and consecutive-block concatenation are explicit", () => {
  const decoder = new Decoder();
  decoder.pushBytes(
    bytes(
      "|1\r\n+k1\r\n:1\r\n",
      "|2\r\n+k2\r\n:2\r\n+k2\r\n:3\r\n",
      "*2\r\n",
      "|1\r\n+first\r\n:1\r\n",
      "+a\r\n",
      "|1\r\n+second\r\n:2\r\n",
      "+b\r\n",
    ),
  );
  const message = asValueMessage(decoder.next());
  assert.deepStrictEqual(
    message.attributes.map((pair) =>
      pair.key.type === "simple-string"
        ? text(pair.key.value)
        : pair.key.type,
    ),
    ["k1", "k2", "k2"],
  );
  assert.equal(message.attributes.length, 3);
  if (message.value.type === "array") {
    assert.equal(message.value.value[0]!.attributes.length, 1);
    assert.equal(message.value.value[1]!.attributes.length, 1);
    assert.equal(message.value.value[0]!.attributes[0]!.value.type, "integer");
  }
});

test("push attributes attach to the push and never leak to the next response", () => {
  const decoder = new Decoder();
  decoder.pushBytes(
    bytes(
      "+before\r\n",
      "|1\r\n+push-tag\r\n+yes\r\n",
      ">1\r\n+payload\r\n",
      "+after\r\n",
    ),
  );
  const first = decoder.next();
  const second = decoder.next();
  const third = decoder.next();
  asValueMessage(first);
  const push = asPushMessage(second);
  const after = asValueMessage(third);
  assert.equal(push.attributes.length, 1);
  assert.equal(push.values.length, 1);
  assert.equal(push.attributes[0]!.key.type, "simple-string");
  if (push.attributes[0]!.key.type === "simple-string") {
    assert.equal(text(push.attributes[0]!.key.value), "push-tag");
  }
  assert.equal(after.attributes.length, 0);
});

test("ranges are absolute and cover attributes plus the actual value", () => {
  const first = bytes("+one\r\n");
  const second = bytes("|1\r\n+k\r\n+v\r\n:2\r\n");
  const decoder = new Decoder();
  decoder.pushBytes(first);
  decoder.pushBytes(second);
  const one = decoder.next();
  const two = decoder.next();
  assert.deepStrictEqual(one?.range, { start: 0, end: first.length });
  assert.deepStrictEqual(two?.range, {
    start: first.length,
    end: first.length + second.length,
  });
});

test("finish distinguishes partial headers, blobs, containers, and orphan attributes", () => {
  const cases: Array<[Uint8Array, TruncationReason]> = [
    [bytes("+partial"), "partial-header"],
    [bytes("+partial\r"), "partial-header"],
    [bytes("$3\r\nab"), "partial-blob"],
    [bytes("$?\r\n;4\r\nabc"), "partial-blob"],
    [bytes("*1\r\n"), "unclosed-container"],
    [bytes("%?\r\n+k\r\n"), "unclosed-container"],
    [bytes("|1\r\n+k\r\n+v\r\n"), "orphan-attributes"],
    [bytes("|0\r\n"), "orphan-attributes"],
  ];
  for (const [input, reason] of cases) {
    const result = finishReason(input);
    assert.equal(result.reason, reason, input.join(","));
    assert.equal(result.at, input.length, "truncation offset is end of input");
  }
});

test("finish reports unusual but well-classified partial attribute frames", () => {
  const result = finishReason(bytes("|1\r\n+k\r\n"));
  assert.equal(result.reason, "unclosed-container");
  assert.equal(result.pendingAttributes, false);
  assert.ok(result.openContainers >= 1);
});

test("clean finish can have complete unread messages and they stay consumable", () => {
  const decoder = new Decoder();
  decoder.pushBytes(bytes("+one\r\n+two\r\n"));
  const finish = decoder.finish();
  assert.deepStrictEqual(finish, {
    clean: true,
    ok: true,
    pendingMessages: 2,
  });
  assert.ok(decoder.next()?.type === "value");
  assert.ok(decoder.next()?.type === "value");
  assert.equal(decoder.next(), null);
});

test("permanent faults preserve earlier complete messages and never deliver the bad frame", () => {
  const decoder = new Decoder();
  decoder.pushBytes(bytes("+good\r\n!unsupported\r\n"));
  asValueMessage(decoder.next());
  assert.throws(
    () => decoder.next(),
    (error: unknown) =>
      error instanceof RespProtocolError && error.code === "unsupported-type",
  );
  assert.equal(decoder.pendingMessages, 0);
  assert.equal(decoder.faultError?.code, "unsupported-type");
  assert.throws(() => decoder.pushBytes(bytes("+ignored\r\n")));
});

test("structural faults are permanent", () => {
  expectFault(bytes("+a\nb\r\n"), "stray-crlf");
  expectFault(bytes("+a\rb\r\n"), "stray-crlf");
  expectFault(bytes("_x\r\n"), "invalid-null");
  expectFault(bytes("$2\r\nabc\r\n"), "invalid-blob-terminator");
  expectFault(bytes("*?\r\n|1\r\n+k\r\n+v\r\n.\r\n"), "invalid-marker");
  expectFault(bytes("%?\r\n+k\r\n.\r\n"), "map-odd");
  expectFault(bytes(">0\r\n"), "invalid-length");
  expectFault(bytes(">?\r\n"), "unsupported-feature");
  expectFault(bytes("|?\r\n+OK\r\n"), "unsupported-feature");
  expectFault(bytes("!bad\r\n"), "unsupported-type");
  expectFault(bytes("*1\r\n>1\r\n+x\r\n"), "nested-push");
  expectFault(bytes(".\r\n"), "invalid-marker");
  expectFault(bytes(";0\r\n"), "invalid-context");
  expectFault(bytes("%1\r\n+k\r\n:1\r\n.\r\n"), "invalid-marker");
});

test("all RESP3 types outside the declared subset are unsupported", () => {
  for (const typeByte of ["#", ",", "(", "!", "=", "~", "\u0000"]) {
    expectFault(bytes(`${typeByte}payload\r\n`), "unsupported-type");
  }
});

test("integer syntax and int64 boundaries are exact", () => {
  for (const token of [
    "+1",
    "-0",
    "00",
    "01",
    "-01",
    "9223372036854775808",
    "-9223372036854775809",
    "1.0",
    "",
  ]) {
    expectFault(bytes(`:${token}\r\n`), "invalid-integer");
  }

  const decoder = new Decoder();
  decoder.pushBytes(
    bytes(":9223372036854775807\r\n:-9223372036854775808\r\n:0\r\n"),
  );
  const values: Array<bigint | undefined> = [];
  for (let index = 0; index < 3; index += 1) {
    const message = asValueMessage(decoder.next());
    values.push(message.value.type === "integer" ? message.value.value : undefined);
  }
  assert.deepStrictEqual(values, [
    9_223_372_036_854_775_807n,
    -9_223_372_036_854_775_808n,
    0n,
  ]);
});

test("lengths reject signs, leading zeros, and RESP2 nulls", () => {
  for (const token of ["-1", "+1", "01", "00", " 1", "1x", ""]) {
    expectFault(bytes(`$ ${token}\r\n`), "invalid-length");
    expectFault(bytes(`$${token}\r\n`), "invalid-length");
  }
  expectFault(bytes("*-1\r\n"), "invalid-length");
  expectFault(bytes("%-1\r\n"), "invalid-length");
  expectFault(bytes("|01\r\n"), "invalid-length");
  expectFault(bytes("$?;\r\n"), "invalid-length");
});

test("declared lengths over budget fail before payload is required", () => {
  const decoder = new Decoder({ maxLeafBytes: 10 });
  decoder.pushBytes(bytes("$11\r\n"));
  assert.throws(
    () => decoder.next(),
    (error: unknown) =>
      error instanceof RespProtocolError && error.code === "limit-leaf",
  );

  const nodes = new Decoder({ maxMessageNodes: 4 });
  nodes.pushBytes(bytes("*4\r\n"));
  assert.throws(
    () => nodes.next(),
    (error: unknown) =>
      error instanceof RespProtocolError && error.code === "limit-nodes",
  );
});

test("exact-budget acceptance and one-byte-short rejection across all budgets", () => {
  // Header bytes include the type prefix and exclude CRLF.
  let decoder = new Decoder({ maxHeaderBytes: 4 });
  decoder.pushBytes(bytes("+abc\r\n"));
  assert.ok(decoder.next()?.type === "value");
  expectFault(bytes("+abc\r\n"), "limit-header", { maxHeaderBytes: 3 });

  // Leaf bytes count simple payloads and blob payloads, including attributes.
  decoder = new Decoder({ maxLeafBytes: 3 });
  decoder.pushBytes(bytes("|1\r\n+k\r\n+v\r\n+x\r\n"));
  assert.ok(decoder.next()?.type === "value");
  expectFault(bytes("|1\r\n+k\r\n+v\r\n+x\r\n"), "limit-leaf", {
    maxLeafBytes: 2,
  });

  decoder = new Decoder({ maxMessageNodes: 3 });
  decoder.pushBytes(bytes("*2\r\n+a\r\n+b\r\n"));
  assert.ok(decoder.next()?.type === "value");
  expectFault(bytes("*2\r\n+a\r\n+b\r\n"), "limit-nodes", {
    maxMessageNodes: 2,
  });

  // A push itself is one node; an empty attribute block is not a node.
  decoder = new Decoder({ maxMessageNodes: 2 });
  decoder.pushBytes(bytes(">1\r\n+a\r\n"));
  assert.ok(decoder.next()?.type === "push");
  expectFault(bytes(">1\r\n+a\r\n"), "limit-nodes", { maxMessageNodes: 1 });
  decoder = new Decoder({ maxMessageNodes: 1 });
  decoder.pushBytes(bytes("|0\r\n+OK\r\n"));
  assert.ok(decoder.next()?.type === "value");
  expectFault(bytes("|1\r\n+k\r\n+v\r\n+OK\r\n"), "limit-nodes", {
    maxMessageNodes: 2,
  });

  decoder = new Decoder({ maxAttributePairs: 1 });
  decoder.pushBytes(bytes("|1\r\n+k\r\n+v\r\n+OK\r\n"));
  assert.ok(decoder.next()?.type === "value");
  expectFault(bytes("|1\r\n+k\r\n+v\r\n+OK\r\n"), "limit-attributes", {
    maxAttributePairs: 0,
  });

  decoder = new Decoder({ maxDepth: 2 });
  decoder.pushBytes(bytes("*1\r\n+a\r\n"));
  assert.ok(decoder.next()?.type === "value");
  expectFault(bytes("*1\r\n+a\r\n"), "limit-depth", { maxDepth: 1 });

  // Attributes add one level to their keys/values; consecutive blocks do not.
  decoder = new Decoder({ maxDepth: 2 });
  decoder.pushBytes(
    bytes("|1\r\n+k1\r\n+v1\r\n|1\r\n+k2\r\n+v2\r\n+OK\r\n"),
  );
  assert.ok(decoder.next()?.type === "value");
  expectFault(
    bytes("|1\r\n+k1\r\n+v1\r\n|1\r\n+k2\r\n+v2\r\n+OK\r\n"),
    "limit-depth",
    { maxDepth: 1 },
  );

  // Empty containers still consume their own node but no child nodes.
  decoder = new Decoder({ maxMessageNodes: 1, maxDepth: 1 });
  decoder.pushBytes(bytes("*0\r\n"));
  assert.ok(decoder.next()?.type === "value");
});

test("streaming blob and stream containers check cumulative budgets", () => {
  const streaming = bytes("$?\r\n;2\r\nab\r\n;2\r\ncd\r\n;0\r\n");
  let decoder = new Decoder({ maxLeafBytes: 4 });
  decoder.pushBytes(streaming);
  assert.ok(decoder.next()?.type === "value");
  expectFault(streaming, "limit-leaf", { maxLeafBytes: 3 });

  const unclosedStream = bytes("*?\r\n+a\r\n+b\r\n+c\r\n.\r\n");
  decoder = new Decoder({ maxMessageNodes: 4 });
  decoder.pushBytes(unclosedStream);
  assert.ok(decoder.next()?.type === "value");
  expectFault(unclosedStream, "limit-nodes", { maxMessageNodes: 3 });
});

test("attribute pairs nested inside attribute values count toward the cap", () => {
  const input = bytes(
    "|3\r\n",
    "|1\r\n+inner\r\n:1\r\n",
    "+k1\r\n:2\r\n",
    "+k2\r\n:3\r\n",
    "+k3\r\n:4\r\n",
    "+OK\r\n",
  );
  let decoder = new Decoder({ maxAttributePairs: 4 });
  decoder.pushBytes(input);
  assert.ok(decoder.next()?.type === "value");
  expectFault(input, "limit-attributes", { maxAttributePairs: 3 });
});

test("finish is clean only at a complete message boundary", () => {
  const decoder = new Decoder();
  decoder.pushBytes(bytes("+OK\r\n"));
  assert.equal(drain(decoder).length, 1);
  const finish = decoder.finish();
  assert.equal(finish.clean, true);
});

test("reference equals decoder for the fixture set under several chunk patterns", () => {
  for (const fixture of validFixtures) {
    const decoder = new Decoder(fixture.limits);
    const messages: unknown[] = [];
    let offset = 0;
    const chunkSizes = [5, 2, 9, 1, 13, 3];
    let cursor = 0;
    while (offset < fixture.wire.length) {
      const size = chunkSizes[cursor % chunkSizes.length]!;
      decoder.pushBytes(fixture.wire.slice(offset, offset + size));
      offset += size;
      cursor += 1;
      while (true) {
        const message = decoder.next();
        if (message === null) break;
        messages.push(message);
      }
    }
    assert.deepStrictEqual(
      messages,
      decodeReference(fixture.wire, fixture.limits).messages,
      fixture.name,
    );
    assert.equal(decoder.finish().clean, true);
  }
});
