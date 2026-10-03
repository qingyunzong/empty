import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const EVENTS = [
  { type: "GROUND_OBSERVATION", obsId: "o1", ts: 10, x: 5, y: 5 },
  {
    type: "FLIGHT_PLAN",
    flightId: "alpha",
    start: 0,
    end: 100,
    polygon: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    version: 1,
  },
  { type: "GROUND_OBSERVATION", obsId: "o2", ts: 11, x: 50, y: 50 },
  { type: "WATERMARK", ts: 16 },
  { type: "RETRACT", flightId: "ghost" },
];

function writeEvents(lines) {
  const dir = mkdtempSync(join(tmpdir(), "flight-tracker-"));
  const input = join(dir, "events.jsonl");
  writeFileSync(input, lines.join("\n") + "\n");
  return { dir, input };
}

function capture() {
  const chunks = [];
  return {
    io: { stdout: (text) => chunks.push(text), stderr: (text) => chunks.push(text) },
    text: () => chunks.join(""),
  };
}

test("cli tracks reads JSONL events and writes JSONL actions to stdout", () => {
  const { input } = writeEvents(EVENTS.map((e) => JSON.stringify(e)));
  const cap = capture();
  const code = run(["tracks", "--in", input], cap.io);
  assert.equal(code, 0);

  const actions = cap.text().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    actions.map((a) => [a.action, a.obsId ?? a.flightId]),
    [
      ["MATCH", "o1"],
      ["UNMATCHED", "o2"],
      ["ERROR", "ghost"],
    ],
  );
  assert.equal(actions[0].flightId, "alpha");
  assert.equal(actions[0].certificate.rule, "even-odd");
  assert.equal(actions[2].error, "UNKNOWN_RETRACT");
});

test("cli supports --out for writing actions to a file", () => {
  const { dir, input } = writeEvents(EVENTS.map((e) => JSON.stringify(e)));
  const output = join(dir, "actions.jsonl");
  const cap = capture();
  const code = run(["tracks", "--in", input, "--out", output], cap.io);
  assert.equal(code, 0);
  assert.equal(cap.text(), "");

  const lines = readFileSync(output, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).action, "MATCH");
});

test("cli reports malformed JSON lines as MALFORMED errors", () => {
  const { input } = writeEvents(['{"type":"WATERMARK","ts":1}', "not json"]);
  const cap = capture();
  const code = run(["tracks", "--in", input], cap.io);
  assert.equal(code, 0);

  const actions = cap.text().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "ERROR");
  assert.equal(actions[0].error, "MALFORMED");
});

test("cli exits non-zero with usage on bad arguments", () => {
  const cap = capture();
  assert.equal(run(["tracks"], cap.io), 1);
  assert.match(cap.text(), /Usage:/);
  assert.equal(run(["bogus", "--in", "x.jsonl"], capture().io), 1);
});
