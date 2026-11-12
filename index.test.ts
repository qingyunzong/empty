import assert from "node:assert/strict";
import test from "node:test";

import { replayInput, type ReplayEvent } from "./index.ts";

let sequence = 0;

const event = (
  type: string,
  generation: number,
  id: string,
  value: string,
  extra: Partial<ReplayEvent> = {},
): ReplayEvent => ({
  seq: ++sequence,
  generation,
  id,
  type,
  value,
  ...extra,
});

test("commits the temporary value when composition ends", () => {
  sequence = 0;
  const events = [
    event("compositionStart", 1, "start-1", ""),
    event("compositionUpdate", 1, "update-1", "你"),
    event("input", 1, "compose-input-1", "你好"),
    event("compositionEnd", 1, "end-1", "你好"),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "你好", sourceId: "end-1" },
  ]);
});

test("commits non-composition input immediately", () => {
  sequence = 0;

  assert.deepEqual(
    replayInput([
      event("input", 1, "input-1", "first"),
      event("input", 1, "input-2", "first-second"),
    ]),
    [
      { value: "first", sourceId: "input-1" },
      { value: "first-second", sourceId: "input-2" },
    ],
  );
});

test("ignores an input whose beforeInput was canceled", () => {
  sequence = 0;
  const events = [
    event("beforeInput", 1, "before-canceled", "ignored", {
      canceled: true,
    }),
    event("input", 1, "input-canceled", "ignored", {
      beforeInputId: "before-canceled",
    }),
    event("beforeInput", 1, "before-kept", "kept"),
    event("input", 1, "input-kept", "kept", {
      beforeInputId: "before-kept",
    }),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "kept", sourceId: "input-kept" },
  ]);
});

test("does not append repeated trailing input after composition end", () => {
  sequence = 0;
  const events = [
    event("compositionStart", 1, "start-1", ""),
    event("compositionUpdate", 1, "update-1", "拼"),
    event("compositionEnd", 1, "end-1", "拼"),
    event("input", 1, "trailing-1", "拼", { beforeInputId: "end-1" }),
    event("input", 1, "trailing-2", "拼", { beforeInputId: "end-1" }),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "拼", sourceId: "end-1" },
  ]);
});

test("deduplicates a trailing input that references both events", () => {
  sequence = 0;
  const events = [
    event("compositionStart", 1, "start-1", ""),
    event("compositionUpdate", 1, "update-1", "拼"),
    event("compositionEnd", 1, "end-1", "拼"),
    event("beforeInput", 1, "before-1", "拼"),
    event("input", 1, "trailing-1", "拼", {
      beforeInputId: "before-1",
      endId: "end-1",
    }),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "拼", sourceId: "end-1" },
  ]);
});

test("rolls back the whole batch for an unknown association", () => {
  sequence = 0;
  const events = [
    event("input", 1, "valid-1", "kept"),
    event("input", 1, "invalid-1", "bad", {
      beforeInputId: "does-not-exist",
    }),
  ];

  const result = replayInput(events);
  assert.deepEqual(result, []);
  assert.equal(result.rolledBack, true);
  assert.equal(result.status, "rolledBack");
});

test("rolls back update or end without an active composition", () => {
  sequence = 0;
  const updateResult = replayInput([
    event("compositionUpdate", 1, "update-1", "x"),
  ]);
  assert.deepEqual(updateResult, []);
  assert.equal(updateResult.rolledBack, true);

  sequence = 0;
  const endResult = replayInput([
    event("input", 1, "input-1", "kept"),
    event("compositionEnd", 1, "end-1", "x"),
  ]);
  assert.deepEqual(endResult, []);
  assert.equal(endResult.rolledBack, true);
});

test("discards a canceled composition without confirming it", () => {
  sequence = 0;
  const events = [
    event("compositionStart", 1, "start-1", ""),
    event("compositionUpdate", 1, "update-1", "hello"),
    event("compositionEnd", 1, "end-1", "hello", { canceled: true }),
    event("input", 1, "input-2", "after-cancel"),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "after-cancel", sourceId: "input-2" },
  ]);
});

test("replaces state on a new generation and ignores stale-generation events", () => {
  sequence = 0;
  const events = [
    event("compositionStart", 1, "start-1", ""),
    event("compositionUpdate", 1, "update-1", "old"),
    event("compositionEnd", 1, "end-1", "old"),
    event("reset", 2, "reset-2", ""),
    event("input", 1, "stale-input-1", "stale"),
    event("compositionUpdate", 1, "stale-update-1", "stale"),
    event("compositionEnd", 1, "stale-end-1", "stale"),
    event("input", 2, "input-2", "new"),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "old", sourceId: "end-1" },
    { value: "new", sourceId: "input-2" },
  ]);
});

test("a new-generation input starts from that event's value", () => {
  sequence = 0;
  const events = [
    event("compositionStart", 1, "start-1", ""),
    event("compositionUpdate", 1, "update-1", "old"),
    event("input", 2, "input-2", "replacement"),
  ];

  assert.deepEqual(replayInput(events), [
    { value: "replacement", sourceId: "input-2" },
  ]);
});
