import test from "node:test";
import assert from "node:assert/strict";

import {
  DecodeError,
  QueryRangeError,
  Rational,
  RecordDecoder,
  decodeAll,
  type ChannelSpec,
  type DecodedRecord,
  type RecordHeaderSpec,
} from "../src/index.js";

const DELIMITER = 0x14;
const DURATION_MARKER = 0x15;
const TERMINATOR = 0x00;
const encoder = new TextEncoder();

type CommentInput = string | Uint8Array;

function encodeComment(comment: CommentInput): number[] {
  const bytes =
    typeof comment === "string"
      ? encoder.encode(comment)
      : Uint8Array.from(comment);
  return [...bytes];
}

function makeTal(
  onset: string,
  duration: string | undefined,
  comments: CommentInput[],
): number[] {
  const output = [...encoder.encode(onset)];
  if (duration !== undefined) {
    output.push(DURATION_MARKER, ...encoder.encode(duration));
  }
  output.push(DELIMITER);
  for (const comment of comments) {
    output.push(...encodeComment(comment), DELIMITER);
  }
  output.push(TERMINATOR);
  return output;
}

function firstTal(onset: string): number[] {
  return makeTal(onset, undefined, [""]);
}

function annotation(talBytes: number[][], capacity: number): Uint8Array {
  const output = new Uint8Array(capacity);
  let position = 0;
  for (const tal of talBytes) {
    if (position + tal.length > capacity) {
      throw new Error("test annotation exceeds its capacity");
    }
    output.set(tal, position);
    position += tal.length;
  }
  return output;
}

function makeRecord(
  spec: RecordHeaderSpec,
  channels: number[][],
  tals: number[][],
): Uint8Array {
  const sampleBytes = spec.channels.reduce((sum, channel) => sum + channel.ns * 2, 0);
  const output = new Uint8Array(sampleBytes + spec.annotationBytes);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (let channelIndex = 0; channelIndex < spec.channels.length; channelIndex++) {
    const channel = spec.channels[channelIndex];
    const values = channels[channelIndex];
    assert.equal(values.length, channel.ns, "fixture sample count");
    for (const value of values) {
      view.setInt16(offset, value, true);
      offset += 2;
    }
  }
  output.set(annotation(tals, spec.annotationBytes), sampleBytes);
  return output;
}

function join(...records: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(records.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const record of records) {
    output.set(record, offset);
    offset += record.length;
  }
  return output;
}

// Independent reference rational arithmetic, used only for per-sample checks.
interface Ref {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

function refQ(n: bigint, d = 1n): Ref {
  if (d === 0n) throw new Error("zero denominator");
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d);
  return { n: (n / divisor) * sign, d: (d < 0n ? -d : d) / divisor };
}

function refAdd(a: Ref, b: Ref): Ref {
  return refQ(a.n * b.d + b.n * a.d, a.d * b.d);
}

function refSub(a: Ref, b: Ref): Ref {
  return refQ(a.n * b.d - b.n * a.d, a.d * b.d);
}

function refMul(a: Ref, b: Ref): Ref {
  return refQ(a.n * b.n, a.d * b.d);
}

function refDiv(a: Ref, b: Ref): Ref {
  return refQ(a.n * b.d, a.d * b.n);
}

function refDecimal(text: string): Ref {
  const slash = text.indexOf("/");
  if (slash >= 0) {
    return refQ(BigInt(text.slice(0, slash)), BigInt(text.slice(slash + 1)));
  }
  const negative = text.startsWith("-");
  const body = text[0] === "+" || text[0] === "-" ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const whole = dot < 0 ? body : body.slice(0, dot);
  const fraction = dot < 0 ? "" : body.slice(dot + 1);
  return refQ(
    (negative ? -1n : 1n) * BigInt(`${whole}${fraction}`),
    10n ** BigInt(fraction.length),
  );
}

function referenceSample(raw: number, channel: ChannelSpec): Ref {
  const dmin = refDecimal(String(channel.digitalMin));
  const dmax = refDecimal(String(channel.digitalMax));
  const pmin = refDecimal(String(channel.physicalMin));
  const pmax = refDecimal(String(channel.physicalMax));
  return refAdd(
    pmin,
    refMul(
      refSub(refQ(BigInt(raw)), dmin),
      refDiv(refSub(pmax, pmin), refSub(dmax, dmin)),
    ),
  );
}

function assertRational(actual: Rational, expected: Ref): void {
  assert.equal(actual.numerator, expected.n);
  assert.equal(actual.denominator, expected.d);
}

function assertSegmentTimes(
  segment: { firstTime: Rational; lastTime: Rational },
  first: Ref,
  last: Ref,
): void {
  assertRational(segment.firstTime, first);
  assertRational(segment.lastTime, last);
}

const multiHeader: RecordHeaderSpec = {
  mode: "D",
  recordDuration: "1/3",
  annotationBytes: 64,
  channels: [
    {
      name: "fast",
      ns: 2,
      digitalMin: -100,
      digitalMax: 100,
      physicalMin: 0,
      physicalMax: 1,
    },
    {
      name: "slow",
      ns: 3,
      digitalMin: 0,
      digitalMax: 10,
      physicalMin: 10,
      physicalMax: -10,
    },
  ],
};

const multiRecord0 = makeRecord(
  multiHeader,
  [
    [150, -200],
    [10, 0, 7],
  ],
  [
    firstTal("+0.25"),
    makeTal("-0.5", "0", ["pre", ""]),
    makeTal("+2.5", undefined, ["after", "dup", "dup"]),
  ],
);

const multiRecord1 = makeRecord(
  multiHeader,
  [
    [-7, 20],
    [5, 5, 1],
  ],
  [
    firstTal("+1.0"),
    makeTal("+1.0", "0.25", ["a", "a"]),
    makeTal("+0.4", "0", ["zero"]),
  ],
);

test("decodes multi-rate D records and converts raw int16 exactly", () => {
  const decoder = new RecordDecoder(multiHeader);
  const source = join(multiRecord0, multiRecord1);
  const committed: DecodedRecord[] = [];
  const sizes = [1, 2, 7, 5, 13, 3, 11];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < source.length) {
    const size = sizes[sizeIndex % sizes.length];
    const records = decoder.push(source.slice(offset, Math.min(source.length, offset + size)));
    committed.push(...records);
    offset += size;
    sizeIndex++;
  }
  decoder.finish();

  assert.equal(decoder.records.length, 2);
  assert.equal(committed.length, 2);
  assert.equal(decoder.records[0].start.toString(), "1/4");
  assert.equal(decoder.records[1].start.toString(), "1");
  assert.equal(decoder.records[0].byteOffset, 0);
  assert.equal(decoder.records[1].byteOffset, decoder.recordBytes);
  assert.equal(decoder.records[0].talCount, 3);
  assert.equal(decoder.records[1].talCount, 3);

  const rawByRecord = [
    [
      [150, -200],
      [10, 0, 7],
    ],
    [
      [-7, 20],
      [5, 5, 1],
    ],
  ];

  for (let recordIndex = 0; recordIndex < rawByRecord.length; recordIndex++) {
    for (let channelIndex = 0; channelIndex < multiHeader.channels.length; channelIndex++) {
      const expectedRaw = rawByRecord[recordIndex][channelIndex];
      assert.deepEqual(
        [...decoder.readSamples(recordIndex, channelIndex, 0, expectedRaw.length)],
        expectedRaw,
      );
      for (let sampleIndex = 0; sampleIndex < expectedRaw.length; sampleIndex++) {
        assert.equal(
          decoder.readSample(recordIndex, channelIndex, sampleIndex),
          expectedRaw[sampleIndex],
        );
        assertRational(
          decoder.sampleValue(recordIndex, channelIndex, sampleIndex),
          referenceSample(expectedRaw[sampleIndex], multiHeader.channels[channelIndex]),
        );
      }
    }
  }
});

test("sample range queries use exact half-open rational endpoints", () => {
  const decoder = new RecordDecoder(multiHeader);
  decoder.push(join(multiRecord0, multiRecord1));
  decoder.finish();

  const segments = decoder.querySamples("1", "1.5");
  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map((segment) => [
      segment.recordIndex,
      segment.channelIndex,
      segment.channelName,
      segment.indexStart,
      segment.indexEnd,
      segment.byteLength,
    ]),
    [
      [1, 0, "fast", 0, 2, 4],
      [1, 1, "slow", 0, 3, 6],
    ],
  );
  assertSegmentTimes(segments[0], refQ(1n), refAdd(refQ(1n), refQ(1n, 6n)));
  assertSegmentTimes(
    segments[1],
    refQ(1n),
    refAdd(refQ(1n), refQ(2n, 9n)),
  );

  // The previous record's last sample is at 0.25 + 1/9, before the lower bound.
  assert.equal(decoder.querySamples("0.25", "0.25").length, 0);
  assert.equal(decoder.querySamples("0.6", "0.9").length, 0);
});

test("event queries select by onset and retain record/TAL/comment order", () => {
  const decoder = new RecordDecoder(multiHeader);
  decoder.push(join(multiRecord0, multiRecord1));
  decoder.finish();

  const events = decoder.queryEvents("0", "3");
  assert.equal(events.length, 6);
  assert.deepEqual(
    events.map((event) => [
      event.recordIndex,
      event.talIndex,
      event.annotationIndex,
      event.onset.toString(),
      event.text,
      event.duration === undefined ? "absent" : event.duration.toString(),
    ]),
    [
      [0, 2, 0, "5/2", "after", "absent"],
      [0, 2, 1, "5/2", "dup", "absent"],
      [0, 2, 2, "5/2", "dup", "absent"],
      [1, 1, 0, "1", "a", "1/4"],
      [1, 1, 1, "1", "a", "1/4"],
      [1, 2, 0, "2/5", "zero", "0"],
    ],
  );

  // onset 1.0 is excluded by the upper endpoint; duration does not matter.
  const narrow = decoder.queryEvents("0", "1.0");
  assert.deepEqual(
    narrow.map((event) => [event.recordIndex, event.talIndex, event.text]),
    [[1, 2, "zero"]],
  );

  // Negative and out-of-record onsets are accepted as ordinary event times.
  const negative = decoder.queryEvents("-1", "0");
  assert.equal(negative.length, 2);
  assert.deepEqual(negative.map((event) => event.text), ["pre", ""]);
  assert.equal(negative[0].onset.toString(), "-1/2");
  assert.equal(negative[1].onset.toString(), "-1/2");
  assert.equal(negative[0].duration?.toString(), "0");
  assert.equal(negative[1].duration?.toString(), "0");

  assert.deepEqual(decoder.queryEvents("1", "1"), []);
  assert.throws(() => decoder.queryEvents("2", "1"), QueryRangeError);
  assert.throws(() => decoder.querySamples("2", "1"), QueryRangeError);
});

test("duration never controls event interval selection", () => {
  const spec: RecordHeaderSpec = {
    mode: "D",
    recordDuration: "1",
    annotationBytes: 40,
    channels: [
      {
        ns: 1,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  const record = makeRecord(
    spec,
    [[0]],
    [
      firstTal("+0"),
      makeTal("+0.5", "100", ["long"]),
      makeTal("+5", "0.1", ["late"]),
    ],
  );
  const decoder = new RecordDecoder(spec);
  decoder.push(record);
  decoder.finish();

  assert.deepEqual(
    decoder.queryEvents("0", "1").map((event) => event.text),
    ["long"],
  );
  // The long duration extends into [10, 20), but its onset does not.
  assert.deepEqual(decoder.queryEvents("10", "20"), []);
  // onset 5 is excluded by the upper endpoint of [4, 5).
  assert.deepEqual(decoder.queryEvents("4", "5"), []);
  assert.deepEqual(
    decoder.queryEvents("5", "6").map((event) => event.text),
    ["late"],
  );
});

test("empty comments become events while zero padding is checked", () => {
  const spec: RecordHeaderSpec = {
    mode: "D",
    recordDuration: "1",
    annotationBytes: 32,
    channels: [
      {
        ns: 1,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  const record = makeRecord(
    spec,
    [[3]],
    [firstTal("+0"), makeTal("+0.1", "0", ["x", "", "x"])],
  );
  const decoder = new RecordDecoder(spec);
  decoder.push(record);
  decoder.finish();

  assert.equal(decoder.records[0].events.length, 3);
  assert.deepEqual(
    decoder.records[0].events.map((event) => [event.annotationIndex, event.text]),
    [
      [0, "x"],
      [1, ""],
      [2, "x"],
    ],
  );
  for (const event of decoder.records[0].events) {
    assert.equal(event.onset.toString(), "1/10");
    assert.equal(event.duration?.toString(), "0");
    assert.equal(event.duration === undefined, false);
  }

  // The first TAL's empty comment is metadata, not an event.
  assert.equal(decoder.queryEvents("0", "1").length, 3);

  const padded = record.slice();
  padded[padded.length - 1] = 1;
  const bad = new RecordDecoder(spec);
  assert.throws(
    () => bad.push(padded),
    (error: unknown) =>
      error instanceof DecodeError && error.code === "INVALID_PADDING",
  );
  assert.equal(bad.records.length, 0);
});

test("invalid UTF-8, controls, and misplaced 0x15 are rejected", () => {
  const spec: RecordHeaderSpec = {
    mode: "D",
    recordDuration: "1",
    annotationBytes: 48,
    channels: [
      {
        ns: 1,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  const cases: Array<{ comment: Uint8Array; code: string }> = [
    { comment: Uint8Array.from([0xff]), code: "INVALID_UTF8" },
    { comment: Uint8Array.from([0x01]), code: "INVALID_COMMENT_CHAR" },
    { comment: Uint8Array.from([0x61, 0x15, 0x62]), code: "INVALID_COMMENT_CHAR" },
  ];
  for (const item of cases) {
    const record = makeRecord(
      spec,
      [[0]],
      [firstTal("+0"), makeTal("+0.1", undefined, [item.comment])],
    );
    const decoder = new RecordDecoder(spec);
    assert.throws(
      () => decoder.push(record),
      (error: unknown) =>
        error instanceof DecodeError && error.code === item.code,
    );
  }

  // TAB, LF, and CR are the only permitted controls in comment text.
  const record = makeRecord(
    spec,
    [[0]],
    [firstTal("+0"), makeTal("+0.1", undefined, ["a\tb\nc\rd"])],
  );
  const decoder = new RecordDecoder(spec);
  decoder.push(record);
  decoder.finish();
  assert.equal(decoder.records[0].events[0].text, "a\tb\nc\rd");
});

test("first TAL shape, non-empty later TALs, and truncation are enforced", () => {
  const spec: RecordHeaderSpec = {
    mode: "D",
    recordDuration: "1",
    annotationBytes: 40,
    channels: [
      {
        ns: 1,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };

  const badFirst = makeRecord(
    spec,
    [[0]],
    [makeTal("+0", "0", [""])],
  );
  const allEmpty = makeRecord(
    spec,
    [[0]],
    [firstTal("+0"), makeTal("+0.1", undefined, ["", ""])],
  );
  const decoders = [new RecordDecoder(spec), new RecordDecoder(spec)];
  assert.throws(
    () => decoders[0].push(badFirst),
    (error: unknown) => error instanceof DecodeError && error.code === "FIRST_TAL",
  );
  assert.throws(
    () => decoders[1].push(allEmpty),
    (error: unknown) => error instanceof DecodeError && error.code === "EMPTY_TAL",
  );

  const truncated = new Uint8Array([0x2b, 0x30, DELIMITER, DELIMITER, 0x01]);
  const truncatedSpec = { ...spec, annotationBytes: truncated.length };
  const decoder = new RecordDecoder(truncatedSpec);
  const truncatedRecord = new Uint8Array(2 + truncated.length);
  truncatedRecord.set(truncated, 2);
  assert.throws(
    () => decoder.push(truncatedRecord),
    (error: unknown) =>
      error instanceof DecodeError && error.code === "TAL_TRUNCATED",
  );

  for (const tals of [
    [firstTal("+0\n")],
    [firstTal("+0"), makeTal("+0.1", "1\n", ["x"])],
    [firstTal("+0"), makeTal("1", undefined, ["x"])],
  ]) {
    const badTime = new RecordDecoder(spec);
    assert.throws(
      () => badTime.push(makeRecord(spec, [[0]], tals)),
      (error: unknown) =>
        error instanceof DecodeError && error.code === "TIME_FORMAT",
    );
  }
});

test("C mode requires exact record continuity and preserves earlier commits", () => {
  const spec: RecordHeaderSpec = {
    mode: "C",
    recordDuration: "1/2",
    annotationBytes: 12,
    channels: [
      {
        ns: 2,
        digitalMin: 0,
        digitalMax: 10,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  const good0 = makeRecord(spec, [[1, 2]], [firstTal("+0.5")]);
  const good1 = makeRecord(spec, [[3, 4]], [firstTal("+1.0")]);
  const decoder = new RecordDecoder(spec);
  decoder.push(join(good0, good1));
  decoder.finish();
  assert.deepEqual(
    decoder.records.map((record) => record.start.toString()),
    ["1/2", "1"],
  );

  const bad1 = makeRecord(spec, [[3, 4]], [firstTal("+1.1")]);
  const never = makeRecord(spec, [[5, 6]], [firstTal("+1.5")]);
  const failing = new RecordDecoder(spec);
  assert.throws(
    () => failing.push(join(good0, bad1, never)),
    (error: unknown) =>
      error instanceof DecodeError &&
      error.code === "RECORD_START_ORDER" &&
      error.recordIndex === 1,
  );
  assert.equal(failing.records.length, 1);
  assert.equal(failing.records[0].start.toString(), "1/2");
  assert.equal(failing.querySamples("0.5", "0.75").length, 1);
  assert.deepEqual(
    [
      failing.querySamples("0.5", "0.75")[0].indexStart,
      failing.querySamples("0.5", "0.75")[0].indexEnd,
    ],
    [0, 1],
  );
  assert.equal(failing.querySamples("0.5", "1").length, 1);
  assert.equal(failing.pendingBytes, 0);
});

test("D mode forbids overlap but permits gaps", () => {
  const spec: RecordHeaderSpec = {
    mode: "D",
    recordDuration: "1",
    annotationBytes: 12,
    channels: [
      {
        ns: 1,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  const good0 = makeRecord(spec, [[0]], [firstTal("+0.25")]);
  const gap = makeRecord(spec, [[0]], [firstTal("+3.5")]);
  const decoder = new RecordDecoder(spec);
  decoder.push(join(good0, gap));
  decoder.finish();
  assert.equal(decoder.records.length, 2);
  assert.equal(decoder.records[1].start.toString(), "7/2");
  // Gaps are not filled with synthetic samples.
  assert.equal(decoder.querySamples("1.1", "3.4").length, 0);

  const overlap = makeRecord(spec, [[0]], [firstTal("+1.0")]);
  const failing = new RecordDecoder(spec);
  assert.throws(
    () => failing.push(join(good0, overlap)),
    (error: unknown) => error instanceof DecodeError && error.code === "RECORD_START_ORDER",
  );
  assert.equal(failing.records.length, 1);
});

test("first record start must satisfy 0 <= start < 1", () => {
  const spec: RecordHeaderSpec = {
    mode: "D",
    recordDuration: "1",
    annotationBytes: 12,
    channels: [
      {
        ns: 1,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  for (const onset of ["-0.5", "+1.0", "+1"]) {
    const decoder = new RecordDecoder(spec);
    assert.throws(
      () => decoder.push(makeRecord(spec, [[0]], [firstTal(onset)])),
      (error: unknown) =>
        error instanceof DecodeError && error.code === "RECORD_START_RANGE",
    );
  }
});

test("exact endpoints, byte sources, and empty intervals", () => {
  const spec: RecordHeaderSpec = {
    mode: "C",
    recordDuration: "1",
    annotationBytes: 8,
    channels: [
      {
        name: "one",
        ns: 4,
        digitalMin: 0,
        digitalMax: 1,
        physicalMin: 0,
        physicalMax: 1,
      },
    ],
  };
  const record = makeRecord(spec, [[11, 12, 13, 14]], [firstTal("+0.5")]);
  const decoder = new RecordDecoder(spec);
  decoder.push(record);
  decoder.finish();

  let segments = decoder.querySamples("0.75", "0.75");
  assert.deepEqual(segments, []);
  segments = decoder.querySamples("0.5", "1");
  assert.equal(segments.length, 1);
  assert.deepEqual(
    [segments[0].indexStart, segments[0].indexEnd, segments[0].byteOffset, segments[0].byteLength],
    [0, 2, 0, 4],
  );
  assertSegmentTimes(segments[0], refQ(1n, 2n), refQ(3n, 4n));

  segments = decoder.querySamples("1", "1.25");
  assert.deepEqual(
    [segments[0].indexStart, segments[0].indexEnd, segments[0].byteOffset, segments[0].byteLength],
    [2, 3, 4, 2],
  );
  assertSegmentTimes(segments[0], refQ(1n), refQ(1n));

  segments = decoder.querySamples("1.25", "1.2501");
  assert.deepEqual(
    [segments[0].indexStart, segments[0].indexEnd, segments[0].byteOffset, segments[0].byteLength],
    [3, 4, 6, 2],
  );
  assertSegmentTimes(segments[0], refQ(5n, 4n), refQ(5n, 4n));

  // The record start equals the upper endpoint and is excluded.
  assert.deepEqual(decoder.querySamples("0", "0.5"), []);
  assert.equal(decoder.recordBytes, 16);
});

test("arbitrary chunking matches whole-input decoding", () => {
  const source = join(multiRecord0, multiRecord1);
  const whole = decodeAll(multiHeader, source);
  const chunked = decodeAll(multiHeader, source, 7);
  assert.equal(chunked.length, whole.length);
  for (let recordIndex = 0; recordIndex < whole.length; recordIndex++) {
    assert.equal(chunked[recordIndex].events.length, whole[recordIndex].events.length);
    assert.equal(chunked[recordIndex].start.toString(), whole[recordIndex].start.toString());
    assert.equal(chunked[recordIndex].byteOffset, whole[recordIndex].byteOffset);
  }

  // Committed bytes are owned by the decoder, not views into caller memory.
  const callerBytes = multiRecord0.slice();
  const isolated = new RecordDecoder(multiHeader);
  isolated.push(callerBytes);
  callerBytes.fill(0);
  assert.equal(isolated.readSample(0, 0, 0), 150);
});

test("a trailing partial record fails without changing committed records", () => {
  const decoder = new RecordDecoder(multiHeader);
  const committed = decoder.push(
    join(multiRecord0, multiRecord1).slice(0, multiRecord0.length + 17),
  );
  assert.equal(committed.length, 1);
  assert.equal(decoder.pendingBytes, 17);
  assert.throws(
    () => decoder.finish(),
    (error: unknown) =>
      error instanceof DecodeError && error.code === "INCOMPLETE_RECORD",
  );
  assert.equal(decoder.records.length, 1);
  assert.throws(
    () => decoder.push(new Uint8Array(0)),
    (error: unknown) =>
      error instanceof DecodeError && error.code === "INCOMPLETE_RECORD",
  );

  const partial = new RecordDecoder(multiHeader);
  partial.push(multiRecord0.slice(0, 10));
  assert.throws(
    () => partial.finish(),
    (error: unknown) =>
      error instanceof DecodeError && error.code === "INCOMPLETE_RECORD",
  );
  assert.equal(partial.records.length, 0);
});
