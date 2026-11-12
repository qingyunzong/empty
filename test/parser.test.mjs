import test from "node:test";
import assert from "node:assert/strict";
import { EdifactStreamParser, EdifactParseError, DEFAULT_SEPARATORS } from "../dist/src/index.js";
import {
  DIRECT,
  GROUPED,
  allComponentTexts,
  expectParseError,
  parseAll,
  parseBytes,
  parseChunks,
} from "./helpers.mjs";

const CUSTOM_UNA = "UNA|~^\\!#";

test("parses a direct exchange and keeps source spans", () => {
  const [exchange] = parseAll(DIRECT);
  assert.equal(exchange.unbRef, "EX1");
  assert.equal(exchange.mode, "direct");
  assert.equal(exchange.count, 1);
  assert.equal(exchange.directMessages.length, 1);
  assert.equal(exchange.groups, null);

  const message = exchange.directMessages[0];
  assert.equal(message.ref, "M1");
  assert.equal(message.type, "ORDERS");
  assert.equal(message.segmentCount, 3);
  assert.equal(message.body.length, 1);
  assert.equal(message.body[0].tag, "BGM");
  assert.deepEqual(allComponentTexts(message.body[0]), [[["123"]]]);
  assert.deepEqual(allComponentTexts(message.unt), [[["3"]], [["M1"]]]);
  assert.deepEqual(allComponentTexts(exchange.unz), [[["1"]], [["EX1"]]]);

  const component = message.body[0].elements[0][0][0];
  assert.equal(component.byteStart, DIRECT.indexOf("123"));
  assert.equal(component.byteEnd, component.byteStart + 3);
  assert.equal(Buffer.from(component.raw).toString(), "123");
  assert.equal(message.body[0].byteEnd - message.body[0].byteStart, "BGM+123'".length);
});

test("reads fixed-width UNA and applies all six custom separators", () => {
  const text =
    CUSTOM_UNA +
    "UNB~E1#UNH~M1~T#BGM~A#UNT~3~M1#UNZ~1~E1#";
  const [exchange] = parseAll(text);

  assert.equal(exchange.unaPresent, true);
  assert.equal(exchange.una.length, 9);
  assert.equal(Buffer.from(exchange.una).toString(), CUSTOM_UNA);
  assert.deepEqual(exchange.separators, {
    component: "|",
    element: "~",
    decimal: "^",
    release: "\\",
    repetition: "!",
    segment: "#",
  });
  assert.equal(exchange.unbRef, "E1");
  assert.equal(exchange.directMessages[0].body[0].elements[0][0][0].text, "A");
});

test("each exchange without UNA independently resets defaults", () => {
  const first = `${CUSTOM_UNA}UNB~E1#UNZ~0~E1#`;
  const second = "UNB+E2'UNZ+0+E2'";
  const exchanges = parseAll(first + second);

  assert.equal(exchanges.length, 2);
  assert.deepEqual(exchanges[0].separators, {
    component: "|",
    element: "~",
    decimal: "^",
    release: "\\",
    repetition: "!",
    segment: "#",
  });
  assert.deepEqual(exchanges[1].separators, DEFAULT_SEPARATORS);
  assert.equal(exchanges[0].unaPresent, true);
  assert.equal(exchanges[1].unaPresent, false);
});

test("two consecutive exchanges may choose different UNAs", () => {
  const first = `${CUSTOM_UNA}UNB~E1#UNZ~0~E1#`;
  const second = "UNA;%&?@$UNB%E2$UNZ%0%E2$";
  const exchanges = parseAll(first + second);

  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].separators.segment, "#");
  assert.equal(exchanges[1].separators.segment, "$");
  assert.equal(exchanges[0].unaPresent, true);
  assert.equal(exchanges[1].unaPresent, true);
});

test("rejects invalid UNA separator bytes", () => {
  for (const text of ["UNA::::::", "UNAA+?*:'", "UNA +?*:'", "UNA\u0001?*:?'"]) {
    expectParseError(() => parseAll(text), "una");
  }
});

test("UNA is only accepted at an exchange start", () => {
  expectParseError(
    () => parseAll("UNA:+.?*'UNA+E'UNZ+0+E'"),
    "envelope",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'UNA+A'UNT+3+M'UNZ+1+E'"),
    "envelope",
  );
});

test("release removes escape semantics exactly once and keeps raw bytes", () => {
  const text =
    "UNB+E'UNH+M+T'FTX+A??B?+C?:D?*E?.F?''UNT+3+M'UNZ+1+E'";
  const [exchange] = parseAll(text);
  const segment = exchange.directMessages[0].body[0];

  assert.deepEqual(allComponentTexts(segment), [[["A?B+C:D*E.F'"]]]);
  const component = segment.elements[0][0][0];
  assert.equal(Buffer.from(component.raw).toString(), "A??B?+C?:D?*E?.F?'");
  assert.equal(component.text, "A?B+C:D*E.F'");
});

test("a released segment terminator does not end the segment", () => {
  const text = "UNB+E'UNH+M+T'BGM+A?''UNT+3+M'UNZ+1+E'";
  const [exchange] = parseAll(text);
  const body = exchange.directMessages[0].body[0];
  assert.deepEqual(allComponentTexts(body), [[["A'"]]]);
  assert.equal(Buffer.from(body.elements[0][0][0].raw).toString(), "A?'");
});

test("decimal is data in ordinary components, never a separator", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'BGM+1.23'UNT+3+M'UNZ+1+E'",
  );
  assert.deepEqual(
    allComponentTexts(exchange.directMessages[0].body[0]),
    [[["1.23"]]],
  );
});

test("preserves consecutive and trailing empty repetitions and components", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'TST+a*::+b+'UNT+3+M'UNZ+1+E'",
  );
  const body = exchange.directMessages[0].body[0];
  assert.deepEqual(allComponentTexts(body), [
    [["a"], ["", "", ""]],
    [["b"]],
    [[""]],
  ]);
});

test("preserves empty elements and empty components", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'TST+++A::'UNT+3+M'UNZ+1+E'",
  );
  const body = exchange.directMessages[0].body[0];
  assert.deepEqual(allComponentTexts(body), [
    [[""]],
    [[""]],
    [["A", "", ""]],
  ]);
});

test("parses grouped exchanges and their counts", () => {
  const [exchange] = parseAll(GROUPED);
  assert.equal(exchange.mode, "group");
  assert.equal(exchange.directMessages, null);
  assert.equal(exchange.count, 1);
  assert.equal(exchange.groups.length, 1);

  const group = exchange.groups[0];
  assert.equal(group.ref, "G1");
  assert.equal(group.count, 1);
  assert.deepEqual(allComponentTexts(group.une), [[["1"]], [["G1"]]]);
  assert.equal(group.messages[0].ref, "GM1");
  assert.equal(group.messages[0].segmentCount, 3);
});

test("accepts empty exchanges and empty groups", () => {
  const emptyExchange = parseAll("UNB+E'UNZ+0+E'")[0];
  assert.equal(emptyExchange.mode, "direct");
  assert.deepEqual(emptyExchange.directMessages, []);
  assert.deepEqual(allComponentTexts(emptyExchange.unz), [[["0"]], [["E"]]]);

  const emptyGroup = parseAll("UNB+G0'UNG+GZ'UNE+0+GZ'UNZ+1+G0'")[0];
  assert.equal(emptyGroup.mode, "group");
  assert.equal(emptyGroup.count, 1);
  assert.equal(emptyGroup.groups[0].messages.length, 0);
  assert.equal(emptyGroup.groups[0].count, 0);
});

test("grouped and direct modes cannot be mixed within one exchange", () => {
  expectParseError(
    () =>
      parseAll(
        "UNB+M'UNH+X+T'UNT+2+X'UNG+G'UNE+0+G'UNZ+1+M'",
      ),
    "envelope",
  );
  expectParseError(
    () =>
      parseAll(
        "UNB+M'UNG+G'UNE+0+G'UNH+X+T'UNT+2+X'UNZ+1+M'",
      ),
    "envelope",
  );
});

test("one grouped and one direct exchange may coexist in the stream", () => {
  const grouped = `${CUSTOM_UNA}UNB~G#UNG~A#UNE~0~A#UNZ~1~G#`;
  const direct = "UNB+D'UNH+X+T'UNT+2+X'UNZ+1+D'";
  const exchanges = parseAll(grouped + direct);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].mode, "group");
  assert.equal(exchanges[1].mode, "direct");
});

test("group refs are unique within an exchange", () => {
  expectParseError(
    () =>
      parseAll(
        "UNB+E'UNG+G'UNE+0+G'UNG+G'UNE+0+G'UNZ+2+E'",
      ),
    "ref",
  );
});

test("message refs are unique across all groups in an exchange", () => {
  expectParseError(
    () =>
      parseAll(
        "UNB+E'UNG+G1'UNH+M+T'UNT+2+M'UNE+1+G1'UNG+G2'UNH+M+T'UNT+2+M'UNE+1+G2'UNZ+2+E'",
      ),
    "ref",
  );
});

test("message refs are unique within direct mode too", () => {
  expectParseError(
    () =>
      parseAll(
        "UNB+E'UNH+M+T'UNT+2+M'UNH+M+T'UNT+2+M'UNZ+2+E'",
      ),
    "ref",
  );
});

test("different exchanges may reuse group and message refs", () => {
  const exchange = "UNB+E'UNH+M+T'UNT+2+M'UNZ+1+E'";
  const exchanges = parseAll(exchange + exchange);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].unbRef, exchanges[1].unbRef);
  assert.equal(exchanges[0].directMessages[0].ref, exchanges[1].directMessages[0].ref);
});

test("UNT count includes UNH and UNT and rejects an off-by-one", () => {
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'BGM+1'UNT+4+M'UNZ+1+E'"),
    "count",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'BGM+1'UNT+2+M'UNZ+1+E'"),
    "count",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'UNT+1+M'UNZ+1+E'"),
    "count",
  );
});

test("UNE, UNZ and UNT require matching refs and counts", () => {
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'UNT+2+X'UNZ+1+E'"),
    "ref",
  );
  expectParseError(
    () => parseAll("UNB+E'UNG+G'UNE+0+H'UNZ+1+E'"),
    "ref",
  );
  expectParseError(
    () => parseAll("UNB+E'UNG+G'UNE+1+G'UNZ+1+E'"),
    "count",
  );
  expectParseError(
    () => parseAll("UNB+E'UNZ+0+X'"),
    "ref",
  );
  expectParseError(
    () => parseAll("UNB+E'UNZ+2+E'"),
    "count",
  );
});

test("counts reject leading zeros and accept zero only as 0", () => {
  expectParseError(
    () => parseAll("UNB+E'UNZ+00+E'"),
    "count",
  );
  expectParseError(
    () => parseAll("UNB+E'UNZ+01+E'"),
    "count",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'UNT+02+M'UNZ+1+E'"),
    "count",
  );
  const [exchange] = parseAll("UNB+E'UNZ+0+E'");
  assert.equal(exchange.count, 0);
});

test("service scalars must be exactly one repetition and one component", () => {
  expectParseError(
    () => parseAll("UNB+A+B'UNZ+0+A'"),
    "service-shape",
  );
  expectParseError(
    () => parseAll("UNB+A*B'UNZ+0+A'"),
    "service-shape",
  );
  expectParseError(
    () => parseAll("UNB+A:B'UNZ+0+A'"),
    "service-shape",
  );
  expectParseError(
    () => parseAll("UNB'UNZ+0+E'"),
    "service-shape",
  );
  expectParseError(
    () => parseAll("UNB+E'UNZ+0'"),
    "service-shape",
  );
});

test("scalar refs may contain released punctuation", () => {
  const [exchange] = parseAll("UNB+A?+B?:C?*D?.E??'UNZ+0+A?+B?:C?*D?.E??'");
  assert.equal(exchange.unbRef, "A+B:C*D.E?");
  assert.equal(exchange.unz.elements[1][0][0].text, "A+B:C*D.E?");
});

test("service tags cannot be skipped as body data and messages/groups cannot nest", () => {
  expectParseError(
    () => parseAll("UNB+E'BGM+1'UNZ+0+E'"),
    "envelope",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'UNT+2+M'UNG+G'UNE+0+G'UNZ+1+E'"),
    "envelope",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'UNH+N+T'UNT+4+N'UNT+5+M'UNZ+1+E'"),
    "envelope",
  );
  expectParseError(
    () => parseAll("UNB+E'UNG+G'UNG+H'UNE+0+G'UNZ+1+E'"),
    "envelope",
  );
  expectParseError(
    () => parseAll("UNB+E'UNG+G'UNZ+1+E'"),
    "envelope",
  );
  expectParseError(
    () => parseAll("UNB+E'UNE+0+G'UNZ+1+E'"),
    "envelope",
  );
});

test("CR and LF are ignored only at legal boundaries", () => {
  const spaced =
    "\r\nUNB+E'\r\nUNH+M+T'\r\nBGM+1'\r\nUNT+3+M'\r\nUNZ+1+E'\r\n";
  const [exchange] = parseAll(spaced);
  assert.equal(exchange.count, 1);

  const afterUna = parseAll("UNA:+.?*'\r\nUNB+E'\r\nUNZ+0+E'");
  assert.equal(afterUna.length, 1);

  const betweenExchanges = parseAll(DIRECT + "\r\n" + "UNB+F'UNZ+0+F'");
  assert.equal(betweenExchanges.length, 2);

  for (const bad of [
    "UNB+E'UNH+M+T'BGM+1\r'UNT+3+M'UNZ+1+E'",
    "UNB+E'UNH+M+T'BGM+1\n'UNT+3+M'UNZ+1+E'",
    "UNB+E'UNH+M+T'BGM+1?\r'UNT+3+M'UNZ+1+E'",
  ]) {
    expectParseError(() => parseAll(bad), "control-byte");
  }
});

test("other control bytes are rejected outside and inside segments", () => {
  expectParseError(
    () => parseAll("UNB+E'\u0001UNZ+0+E'"),
    "control-byte",
  );
  expectParseError(
    () => parseAll("UNB+E'UNH+M+T'BGM+\u0001'UNT+3+M'UNZ+1+E'"),
    "control-byte",
  );
});

test("strict UTF-8 is validated per final component", () => {
  const valid = parseAll("UNB+E'UNH+M+T'BGM+\u4f60\u597d'UNT+3+M'UNZ+1+E'");
  assert.equal(
    valid[0].directMessages[0].body[0].elements[0][0][0].text,
    "\u4f60\u597d",
  );

  const invalid = new Uint8Array(
    new TextEncoder().encode("UNB+E'UNH+M+T'BGM+"),
  );
  const invalidTail = new TextEncoder().encode("'UNT+3+M'UNZ+1+E'");
  const bytes = new Uint8Array(invalid.length + 2 + invalidTail.length);
  bytes.set(invalid, 0);
  bytes.set([0xc3, 0x28], invalid.length);
  bytes.set(invalidTail, invalid.length + 2);
  expectParseError(() => parseBytes(bytes), "utf8");

  const splitCodePoint = new Uint8Array(
    new TextEncoder().encode("UNB+E'UNH+M+T'BGM+"),
  );
  const after = new TextEncoder().encode("'UNT+3+M'UNZ+1+E'");
  const splitBytes = new Uint8Array(splitCodePoint.length + 1 + 1 + 2 + after.length);
  splitBytes.set(splitCodePoint, 0);
  splitBytes.set([0xe4], splitCodePoint.length);
  splitBytes.set([0x3a], splitCodePoint.length + 1);
  splitBytes.set([0xbd, 0xa0], splitCodePoint.length + 2);
  splitBytes.set(after, splitCodePoint.length + 4);
  expectParseError(() => parseBytes(splitBytes), "utf8");
});

test("cross-chunk UTF-8 remains one component", () => {
  const text = "UNB+E'UNH+M+T'BGM+\u4f60\u597d'UNT+3+M'UNZ+1+E'";
  const bytes = new TextEncoder().encode(text);
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  const [exchange] = parseChunks(chunks);
  const component = exchange.directMessages[0].body[0].elements[0][0][0];
  assert.equal(component.text, "\u4f60\u597d");
  assert.equal(component.byteEnd - component.byteStart, 6);
  assert.deepEqual(Array.from(component.raw), [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
});

test("release at EOF is rejected at finish", () => {
  const parser = new EdifactStreamParser();
  parser.push("UNB+E'UNH+M+T'BGM+A?");
  expectParseError(() => parser.finish(), "release-eof");
  expectParseError(() => parser.push(DIRECT), "terminal");
  expectParseError(() => parser.finish(), "terminal");
});

test("finish rejects residual UNA, residual segments and open envelopes", () => {
  for (const [text, code] of [
    ["UNA:+.?", "finish-una"],
    ["UNA:+.?*'", "finish-una"],
    ["UNB+E", "finish-segment"],
    ["UNB+E'UNH+M+T'UNT+2+M'", "finish-envelope"],
    ["UNB+E'UNH+M+T'BGM+1'UNT+3+M'UNZ+1+E'UNB", "finish-segment"],
  ]) {
    const parser = new EdifactStreamParser();
    parser.push(text);
    expectParseError(() => parser.finish(), code);
  }

  const parser = new EdifactStreamParser();
  parser.push(DIRECT);
  parser.finish();
  expectParseError(() => parser.push(DIRECT), "terminal");
});

test("a bad later exchange keeps already delivered exchanges and fails terminally", () => {
  const delivered = [];
  const parser = new EdifactStreamParser({
    onExchange: (exchange) => delivered.push(exchange),
  });

  expectParseError(
    () =>
      parser.push(
        DIRECT +
          "UNB+BAD'UNH+X+T'BGM+1'UNT+4+X'UNZ+1+BAD'",
      ),
    "count",
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].unbRef, "EX1");
  assert.equal(delivered[0].unz.tag, "UNZ");

  expectParseError(() => parser.push(DIRECT), "terminal");
  expectParseError(() => parser.finish(), "terminal");
});

test("enforces configurable stream limits while reading", () => {
  expectParseError(
    () => parseAll(DIRECT, { limits: { maxExchangeBytes: 20 } }),
    "limit-exchange-bytes",
  );
  expectParseError(
    () => parseAll(DIRECT, { limits: { maxSegments: 4 } }),
    "limit-segments",
  );
  expectParseError(
    () =>
      parseAll("UNB+E'UNH+M+T'BGM+1234'UNT+3+M'UNZ+1+E'", {
        limits: { maxComponentBytes: 3 },
      }),
    "limit-component-bytes",
  );
  expectParseError(
    () =>
      parseAll("UNB+E'UNH+M+T'BGM+A*B*C'UNT+3+M'UNZ+1+E'", {
        limits: { maxRepetitions: 2 },
      }),
    "limit-repetitions",
  );

  const [exchange] = parseAll(DIRECT, {
    limits: {
      maxExchangeBytes: DIRECT.length,
      maxSegments: 5,
      maxComponentBytes: 6,
      maxRepetitions: 1,
    },
  });
  assert.equal(exchange.count, 1);
});

test("rejects an exchange with a non-UNB first segment", () => {
  expectParseError(
    () => parseAll("UNH+M+T'UNT+2+M'UNZ+1+E'"),
    "envelope",
  );
});
