// Acceptance 3: tombstone delete + compact physically removes the code;
// neighbours no longer match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { decodeSegment } from "../src/segment.js";
import { tmpDir, cleanup } from "./helpers.js";

const EVENTS = [
  { seq: 0, ts: 100, code: "TIMEOUT" },
  { seq: 1, ts: 110, code: "OLD" },
  { seq: 2, ts: 120, code: "OLD" },
  { seq: 3, ts: 130, code: "TIMEOUT" },
  { seq: 4, ts: 140, code: "NEW" },
  { seq: 5, ts: 150, code: "OLD" },
  { seq: 6, ts: 160, code: "TIMEOUT" },
];

test("delete old code then compact: cooccur no longer hits, bytes physically gone", () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    for (const e of EVENTS) store.ingest(e);
    store.freeze();

    const before = store.queryCooccur({ device: "OLD", timeout: "TIMEOUT", window: 5 });
    assert.ok(before.count > 0, "OLD must co-occur before delete");

    store.deleteCode("OLD");
    // tombstone alone already hides it from queries
    assert.equal(store.queryCooccur({ device: "OLD", timeout: "TIMEOUT", window: 5 }).count, 0);

    const compacted = store.compact();
    assert.equal(compacted.merged, true);
    assert.equal(compacted.count, 4, "3 OLD events physically dropped");
    assert.equal(compacted.tombstonesCleared, true);

    const after = store.queryCooccur({ device: "OLD", timeout: "TIMEOUT", window: 5 });
    assert.equal(after.count, 0, "neighbours no longer hit after compact");

    // physical check: merged segment contains no record with the OLD codeId
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.tombstones, []);
    const oldId = manifest.dict.OLD;
    const segFiles = readdirSync(dir).filter((f) => f.startsWith("seg-"));
    assert.equal(segFiles.length, 1, "old frozen segment replaced by merged one");
    const dec = decodeSegment(readFileSync(join(dir, segFiles[0])));
    assert.equal(dec.error, null);
    assert.equal(dec.records.length, 4);
    assert.ok(dec.records.every((r) => r.codeId !== oldId), "OLD codeId absent from merged segment");

    // remaining events keep original seq/ts
    assert.deepEqual(
      dec.records.map((r) => r.seq),
      [0, 3, 4, 6],
    );
    assert.deepEqual(
      dec.records.map((r) => r.ts),
      [100, 130, 140, 160],
    );
  } finally {
    cleanup(dir);
  }
});

test("deleted code cannot be re-ingested", () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    store.ingest({ seq: 0, ts: 1, code: "OLD" });
    store.deleteCode("OLD");
    assert.throws(() => store.ingest({ seq: 1, ts: 2, code: "OLD" }), /deleted/);
  } finally {
    cleanup(dir);
  }
});
