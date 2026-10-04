import { Buffer } from "node:buffer";
import test from "node:test";
import assert from "node:assert/strict";
import { CsvParser, parseCsv, type RecordInfo } from "../src/csv.ts";

/** Parse `input` fed as chunks split at the given byte positions. */
function parseWithSplits(input: Buffer, splits: number[]): RecordInfo[] {
  const parser = new CsvParser();
  let prev = 0;
  for (const at of splits) {
    parser.feed(input.subarray(prev, at));
    prev = at;
  }
  parser.feed(input.subarray(prev));
  parser.end();
  return parser.records;
}

/** Strip parser instances to plain data for deep comparison. */
function plain(records: RecordInfo[]): unknown {
  return JSON.parse(JSON.stringify(records));
}

/** Every field's raw range must map back to the exact source bytes. */
function assertRawRanges(input: Buffer, records: RecordInfo[]): void {
  for (const record of records) {
    assert.ok(record.start <= record.end);
    assert.ok(record.end <= input.length);
    for (const field of record.fields) {
      assert.equal(field.recordIndex, record.index);
      assert.ok(field.start <= field.end, `field range ${field.start}..${field.end}`);
      assert.equal(
        input.subarray(field.start, field.end).toString("utf8"),
        field.raw,
        `raw range mismatch for field ${field.recordIndex}:${field.fieldIndex}`,
      );
    }
  }
}

test("simple records and fields with raw ranges", () => {
  const records = parseCsv("a,b\nc,d\n");
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.fields.map((f) => [f.raw, f.value, f.start, f.end])),
    [
      [
        ["a", "a", 0, 1],
        ["b", "b", 2, 3],
      ],
      [
        ["c", "c", 4, 5],
        ["d", "d", 6, 7],
      ],
    ],
  );
  assert.deepEqual(
    records.map((r) => [r.start, r.end]),
    [
      [0, 4],
      [4, 8],
    ],
  );
});

test("legal quotes: embedded newline does not split the record", () => {
  const records = parseCsv('"a\nb",c\nd,e\n');
  assert.equal(records.length, 2);
  const [first] = records;
  assert.equal(first.fields.length, 2);
  assert.equal(first.fields[0].raw, '"a\nb"');
  assert.equal(first.fields[0].value, "a\nb");
  assert.equal(first.fields[0].quoted, true);
  assert.equal(first.fields[0].malformed, false);
  assert.equal(first.fields[1].value, "c");
  assert.equal(first.end, 8); // includes the terminating \n
});

test("legal quotes: escaped quotes and CRLF inside quotes", () => {
  const records = parseCsv('"say ""hi""\r\nnow",x\n');
  assert.equal(records.length, 1);
  assert.equal(records[0].fields[0].value, 'say "hi"\r\nnow');
  assert.equal(records[0].fields[0].raw, '"say ""hi""\r\nnow"');
});

test("illegal quote is quarantined to the physical line end", () => {
  // The stray quote in `a"b` must not open a quoted section: the newline
  // still terminates the record and `c` stays a separate field.
  const records = parseCsv('a"b,c\nd,e\n');
  assert.equal(records.length, 2);
  assert.equal(records[0].fields.length, 2);
  assert.equal(records[0].fields[0].raw, 'a"b');
  assert.equal(records[0].fields[0].value, 'a"b');
  assert.equal(records[0].fields[0].quoted, false);
  assert.equal(records[0].fields[0].malformed, true);
  assert.equal(records[0].fields[1].value, "c");
  assert.deepEqual(records[1].fields.map((f) => f.value), ["d", "e"]);
});

test("junk after a closing quote is quarantined to the physical line end", () => {
  const records = parseCsv('"ab"cd"ef",g\nh,i\n');
  assert.equal(records.length, 2);
  const field = records[0].fields[0];
  assert.equal(field.raw, '"ab"cd"ef"');
  assert.equal(field.value, 'abcd"ef"');
  assert.equal(field.quoted, true);
  assert.equal(field.malformed, true);
  assert.equal(records[0].fields[1].value, "g");
});

test("CRLF, lone CR, and CR at end of input", () => {
  const crlf = parseCsv("a,b\r\nc,d\r\n");
  assert.equal(crlf.length, 2);
  assert.deepEqual(
    crlf.map((r) => [r.start, r.end]),
    [
      [0, 5],
      [5, 10],
    ],
  );
  const loneCr = parseCsv("a,b\rc,d");
  assert.equal(loneCr.length, 2);
  assert.deepEqual(loneCr[1].fields.map((f) => f.value), ["c", "d"]);
  const trailingCr = parseCsv("a,b\r");
  assert.equal(trailingCr.length, 1);
  assert.equal(trailingCr[0].end, 4);
});

test("empty fields, trailing comma, blank lines, empty input", () => {
  const records = parseCsv("a,\n,b\n\n");
  assert.equal(records.length, 3);
  assert.deepEqual(records[0].fields.map((f) => f.value), ["a", ""]);
  assert.deepEqual(records[1].fields.map((f) => f.value), ["", "b"]);
  assert.deepEqual(records[2].fields.map((f) => f.value), [""]);
  assert.equal(parseCsv("").length, 0);
  assert.equal(parseCsv("a,")[0].fields.length, 2);
  assert.equal(parseCsv('""')[0].fields[0].value, "");
  assert.equal(parseCsv('""')[0].fields[0].quoted, true);
});

test("multi-byte UTF-8 keeps byte-accurate ranges", () => {
  const input = Buffer.from('名字,"值💰"\n');
  const records = parseCsv(input);
  assert.equal(records.length, 1);
  assert.deepEqual(
    records[0].fields.map((f) => [f.start, f.end]),
    [
      [0, 6],
      [7, 16],
    ],
  );
  assert.equal(records[0].fields[1].value, "值💰");
  assertRawRanges(input, records);
});

test("unterminated quote at EOF flushes the open field", () => {
  const records = parseCsv('"ab');
  assert.equal(records.length, 1);
  assert.equal(records[0].fields[0].value, "ab");
  assert.equal(records[0].fields[0].quoted, true);
});

// --- Chunk-split enumeration against whole-buffer parsing -----------------

const CASES: Array<[string, Buffer]> = [
  ["simple", Buffer.from("a,b\nc,d\n")],
  ["quoted-newline", Buffer.from('"a\nb",c\nd,e\n')],
  ["escaped-quotes", Buffer.from('"say ""hi""",x\n')],
  ["illegal-quote", Buffer.from('a"b,c\nd,"e\nf",g\n')],
  ["junk-after-quote", Buffer.from('"ab"cd"ef",g\nh,i\n')],
  ["crlf-and-lone-cr", Buffer.from("a,b\r\nc,d\re,f\n")],
  ["utf8", Buffer.from('名字,"值💰"\n行二,"尾"\n')],
  ["empties", Buffer.from("a,\n,b\n\n")],
  ["mixed", Buffer.from('x,"y\nz",w"q\n"1""2",t\r\nu,v')],
];

test("every 2-chunk split position matches whole-buffer parsing", () => {
  for (const [name, input] of CASES) {
    const whole = parseCsv(input);
    assertRawRanges(input, whole);
    for (let at = 1; at < input.length; at++) {
      const chunked = parseWithSplits(input, [at]);
      assert.deepEqual(plain(chunked), plain(whole), `${name}: split at byte ${at}`);
    }
  }
});

test("every 3-chunk split pair matches whole-buffer parsing", () => {
  const input = Buffer.from('a,"b\nc",d"e\nf,"g""h"\r\ni,j');
  const whole = parseCsv(input);
  assertRawRanges(input, whole);
  let checked = 0;
  for (let first = 1; first < input.length - 1; first++) {
    for (let second = first + 1; second < input.length; second++) {
      const chunked = parseWithSplits(input, [first, second]);
      assert.deepEqual(
        plain(chunked),
        plain(whole),
        `split at bytes ${first} and ${second}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test("byte-at-a-time feeding matches whole-buffer parsing", () => {
  for (const [name, input] of CASES) {
    const whole = parseCsv(input);
    const parser = new CsvParser();
    for (let i = 0; i < input.length; i++) parser.feed(input.subarray(i, i + 1));
    parser.end();
    assert.deepEqual(plain(parser.records), plain(whole), `${name}: byte-at-a-time`);
  }
});

test("records accumulate identically regardless of emission timing", () => {
  const input = Buffer.from('a,"b\nc"\r\nd,e\n');
  const whole = parseCsv(input);
  const parser = new CsvParser();
  const streamed: RecordInfo[] = [];
  for (let at = 1; at <= input.length; at++) {
    streamed.push(...parser.feed(input.subarray(at - 1, at)));
  }
  streamed.push(...parser.end());
  assert.deepEqual(plain(streamed), plain(whole));
  assert.deepEqual(plain(parser.records), plain(whole));
});
