import test from "node:test";
import assert from "node:assert/strict";
import { processLines } from "../src/cli.js";

const EVENTS = [
  { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 },
  { type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 10, yield: 5, quality: 0.9 },
  { type: "READ_METRIC", metricId: "m2", batchId: "b1", ts: 90, yield: 6, quality: 0.8 },
  { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 50, version: 2 },
  { type: "WATERMARK", ts: 200 },
];

test("cli emits JSONL actions followed by the final certificate", () => {
  const lines = processLines(EVENTS.map((e) => JSON.stringify(e)));
  const certificate = lines.at(-1);
  assert.equal(certificate.type, "CERTIFICATE");
  assert.deepEqual(certificate.counts, { batches: 1, metrics: 2, matched: 1, unmatched: 1 });
  assert.deepEqual(certificate.batches[0].versions, [1, 2]);

  const actions = lines.slice(0, -1);
  assert.ok(actions.every((line) => line.type === "ACTION"));
  assert.deepEqual(
    actions.map((a) => [a.action, a.metricId ?? a.batchId]),
    [
      ["ADD", "m1"],
      ["ADD", "m2"],
      ["WITHDRAW", "m2"],
    ],
  );
});

test("cli reports malformed lines as INVALID_JSON actions", () => {
  const lines = processLines(['{"type":"WATERMARK","ts":1}', "not json"]);
  assert.equal(lines[0].action, "INVALID_JSON");
  assert.equal(lines.at(-1).type, "CERTIFICATE");
});
