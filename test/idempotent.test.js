// Acceptance 4: re-ingesting the same seq is idempotent; gaps raise E_SEQ.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, PLCError } from "../src/store.js";
import { tmpDir, cleanup, cli, cliJson } from "./helpers.js";

test("duplicate seq is a no-op, gap raises E_SEQ", () => {
  const dir = tmpDir();
  try {
    const store = new Store(dir);
    for (let i = 0; i < 10; i++) {
      const r = store.ingest({ seq: i, ts: 1000 + i, code: "C" + (i % 3) });
      assert.equal(r.dedup, false);
    }
    const dup = store.ingest({ seq: 5, ts: 1005, code: "C2" });
    assert.deepEqual(dup, { dedup: true, seq: 5, nextSeq: 10 });

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.nextSeq, 10, "nextSeq unchanged by duplicate");
    assert.equal(manifest.segments[0].count, 10, "no duplicate record written");

    assert.throws(
      () => store.ingest({ seq: 15, ts: 1015, code: "C0" }),
      (e) => e instanceof PLCError && e.code === "E_SEQ",
    );
    const ok = store.ingest({ seq: 10, ts: 1010, code: "C1" });
    assert.equal(ok.dedup, false);
    assert.equal(store.ingest({ seq: 10, ts: 1010, code: "C1" }).dedup, true);
  } finally {
    cleanup(dir);
  }
});

test("CLI: repeated ingest of same seq reports dedup and keeps state", () => {
  const dir = tmpDir();
  try {
    const args = ["ingest", "--seq", "0", "--ts", "42", "--code", "ALARM"];
    const first = cliJson(dir, args);
    assert.equal(first.code, 0);
    assert.equal(first.json.dedup, false);
    const second = cliJson(dir, args);
    assert.equal(second.code, 0);
    assert.equal(second.json.dedup, true);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.segments[0].count, 1);
  } finally {
    cleanup(dir);
  }
});

test("CLI error codes: E_SEQ on gap, E_RANGE on bad window", () => {
  const dir = tmpDir();
  try {
    const gap = cli(dir, ["ingest", "--seq", "7", "--ts", "1", "--code", "X"]);
    assert.equal(gap.code, 1);
    assert.match(gap.stderr, /E_SEQ/);
    const badWindow = cli(dir, ["query", "cooccur", "--device", "A", "--timeout", "B", "--window", "-1"]);
    assert.equal(badWindow.code, 1);
    assert.match(badWindow.stderr, /E_RANGE/);
    const unknown = cli(dir, ["bogus"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /E_RANGE/);
  } finally {
    cleanup(dir);
  }
});
