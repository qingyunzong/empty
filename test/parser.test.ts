import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { CONTROL_SEQUENCES, SessionParser } from "../src/index.js";
import type { Segment, SentCommand } from "../src/index.js";

type Step = { send: string } | { write: Buffer } | { end: true };

function run(steps: Step[]): SessionParser {
  const parser = new SessionParser();
  for (const step of steps) {
    if ("send" in step) parser.send(step.send);
    else if ("write" in step) parser.write(step.write);
    else parser.end();
  }
  return parser;
}

interface Snapshot {
  segments: Segment[];
  commands: SentCommand[];
  visible: string;
  output: string;
  echo: string;
  sent: string;
}

function snapshot(parser: SessionParser): Snapshot {
  return {
    segments: parser.segments.map((s) => ({ ...s })),
    commands: parser.commands.map((c) => ({ ...c })),
    visible: parser.visibleText(),
    output: parser.outputText(),
    echo: parser.echoText(),
    sent: parser.sentText(),
  };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomSplit(buf: Buffer, pieces: number, rand: () => number): Buffer[] {
  if (buf.length < 2 || pieces < 2) return [buf];
  const cuts = new Set<number>();
  while (cuts.size < pieces - 1) cuts.add(1 + Math.floor(rand() * (buf.length - 1)));
  const points = [0, ...[...cuts].sort((a, b) => a - b), buf.length];
  const out: Buffer[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) out.push(buf.subarray(points[i]!, points[i + 1]!));
  return out;
}

/** Re-run the script with every write part split by `split`; compare snapshots. */
function assertChunkInvariant(steps: Step[], split: (part: Buffer) => Buffer[]): void {
  const expected = snapshot(run(steps));
  const chunked: Step[] = [];
  for (const step of steps) {
    if ("write" in step) for (const piece of split(step.write)) chunked.push({ write: piece });
    else chunked.push(step);
  }
  deepEqual(snapshot(run(chunked)), expected);
}

test("keeps sent bytes, echo and program output apart", () => {
  const parser = new SessionParser();
  parser.send("echo hi\r");
  parser.write("echo hi\r\nhi\r\n$ ");
  parser.end();

  equal(parser.echoText(), "echo hi");
  equal(parser.outputText(), "hi$ ");
  ok(!parser.outputText().includes("echo hi"), "echo must not be reported as output");
  equal(parser.sentText(), "echo hi\r");
  deepEqual(
    parser.segments.map((s) => [s.kind, s.text]),
    [
      ["echo", "echo hi"],
      ["control", "\r"],
      ["control", "\n"],
      ["output", "hi"],
      ["control", "\r"],
      ["control", "\n"],
      ["output", "$ "],
    ],
  );
});

test("applies control sequences from the public finite table", () => {
  equal(run([{ write: Buffer.from("abc\b\bXY") }, { end: true }]).visibleText(), "aXY");
  equal(run([{ write: Buffer.from("hello\r\x1b[Khi") }, { end: true }]).visibleText(), "hi");
  equal(run([{ write: Buffer.from("\x1b[1;31mred\x1b[0m!") }, { end: true }]).visibleText(), "red!");
  equal(
    run([{ write: Buffer.from("one\r\ntwo\r\nthree") }, { end: true }]).visibleText(),
    "one\ntwo\nthree",
  );
  const sgr = run([{ write: Buffer.from("\x1b[32mok\x1b[0m") }, { end: true }]);
  deepEqual(
    sgr.segments.filter((s) => s.kind === "control").map((s) => [s.name, s.known]),
    [
      ["CSI_SGR", true],
      ["CSI_SGR", true],
    ],
  );
});

test("marks truncated commands as incomplete", () => {
  const parser = new SessionParser();
  const truncated = parser.send("sleep 5");
  const finished = parser.send("ls\r");
  equal(truncated.complete, false);
  equal(finished.complete, true);
  equal(parser.commands.length, 2);
  equal(parser.sentText(), "sleep 5ls\r");
});

test("marks a truncated escape sequence as incomplete", () => {
  const parser = run([{ write: Buffer.from("out\x1b[32") }, { end: true }]);
  const last = parser.segments[parser.segments.length - 1]!;
  equal(last.kind, "control");
  equal(last.complete, false);
  equal(last.name, "INCOMPLETE");
  equal(last.text, "\x1b[32");
  equal(parser.visibleText(), "out");
  equal(parser.outputText(), "out");
});

test("consumes unknown escape sequences without visible-text effects", () => {
  const parser = run([{ write: Buffer.from("a\x1b[5~b\x1bXc") }, { end: true }]);
  const unknown = parser.segments.filter((s) => s.kind === "control");
  deepEqual(
    unknown.map((s) => [s.text, s.known]),
    [
      ["\x1b[5~", false],
      ["\x1bX", false],
    ],
  );
  equal(parser.visibleText(), "abc");
  equal(parser.outputText(), "abc");
});

test("segment offsets address the original received bytes", () => {
  const received = Buffer.from(
    'echo "hé"\r\n\x1b[1;32mhé\x1b[0m\r\nabc\b\bXY\r\n$ \x1b[3',
    "utf8",
  );
  const parser = run([{ send: 'echo "hé"\r' }, { write: received }, { end: true }]);
  ok(parser.segments.length > 5);
  let cursor = 0;
  for (const segment of parser.segments) {
    equal(segment.start, cursor, "segments must tile the stream without gaps");
    cursor = segment.end;
    equal(
      received.subarray(segment.start, segment.end).toString("utf8"),
      segment.text,
      `segment [${segment.start}, ${segment.end}) must slice back its own text`,
    );
  }
  equal(cursor, received.length);
  const sent = Buffer.from('echo "hé"\r', "utf8");
  const command = parser.commands[0]!;
  equal(sent.subarray(command.start, command.end).toString("utf8"), command.text);
});

const SCRIPT: Step[] = [
  { send: 'echo "hé"\r' },
  {
    write: Buffer.from(
      'echo "hé"\r\n' +
        "\x1b[1;32mhé\x1b[0m\r\n" +
        "abc\b\bXY\r\n" +
        "junk\x1b[2K\r\n" +
        "\x1b[5~" +
        "pos\x1b[2;3H!" +
        "\r\n$ ",
      "utf8",
    ),
  },
  { send: "pwd" }, // truncated command: no terminator
  { write: Buffer.from("pwd/home/hé\x1b[3", "utf8") }, // truncated CSI at the end
  { end: true },
];

test("arbitrary chunking and whole-buffer parsing agree (exhaustive 2-splits)", () => {
  const parts = SCRIPT.filter((s): s is { write: Buffer } => "write" in s).map((s) => s.write);
  const whole = Buffer.concat(parts);
  const singleWrite: Step[] = [
    { send: 'echo "hé"\r' },
    { send: "pwd" },
    { write: whole },
    { end: true },
  ];
  for (let i = 0; i <= whole.length; i += 1) {
    assertChunkInvariant(singleWrite, () => [whole.subarray(0, i), whole.subarray(i)]);
  }
});

test("arbitrary chunking and whole-buffer parsing agree (random multi-splits)", () => {
  const rand = lcg(0x5eed);
  for (let trial = 0; trial < 200; trial += 1) {
    const pieces = 2 + Math.floor(rand() * 7);
    assertChunkInvariant(SCRIPT, (part) => randomSplit(part, pieces, rand));
  }
});

test("byte-at-a-time feeding agrees with whole-buffer parsing", () => {
  assertChunkInvariant(SCRIPT, (part) => {
    const out: Buffer[] = [];
    for (let i = 0; i < part.length; i += 1) out.push(part.subarray(i, i + 1));
    return out;
  });
});

test("the control table is public, finite and consistently defined", () => {
  ok(Array.isArray(CONTROL_SEQUENCES));
  ok(CONTROL_SEQUENCES.length > 0);
  const names = new Set<string>();
  for (const spec of CONTROL_SEQUENCES) {
    ok(!names.has(spec.name), `duplicate control name ${spec.name}`);
    names.add(spec.name);
    ok(Number.isInteger(spec.firstByte) && spec.firstByte >= 0 && spec.firstByte <= 0xff);
    ok(spec.pattern.source.startsWith("^"), "patterns must be anchored");
    equal(typeof spec.effect, "string");
  }
});
