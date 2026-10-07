import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../cli.js";

// The sandbox blocks node->node process spawning, so the CLI is tested
// in-process through its exported run() with injected I/O. Behavior is
// identical to `node cli.js ...` (verified manually from the shell).

function makeIo(files) {
  const stderrLines = [];
  return {
    io: {
      readFile: (path) => {
        if (!(path in files)) throw new Error(`ENOENT: no such file: ${path}`);
        return files[path];
      },
      writeFile: (path, text) => {
        files[path] = text;
      },
      stderr: (msg) => stderrLines.push(msg),
    },
    stderrLines,
  };
}

const ev = (o) => JSON.stringify(o);

test("CLI settle writes window records and --naive verifies a full replay", () => {
  const files = {
    "in.jsonl": [
      ev({ type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1000 }),
      ev({ type: "capture", id: "c2", mch: "m1", amt: 700, ts: 2000 }),
      ev({ type: "void", id: "c1", mch: "m1", ts: 2500 }),
      ev({ type: "capture", id: "z1", mch: "m9", amt: 1, ts: 400000 }),
      "",
    ].join("\n"),
  };
  const { io, stderrLines } = makeIo(files);
  const code = run(["settle", "--in", "in.jsonl", "--wm", "3000", "--out", "out.jsonl", "--naive"], io);
  assert.equal(code, 0);
  assert.ok(stderrLines.some((l) => /naive-check: OK/.test(l)), stderrLines.join("\n"));

  const records = files["out.jsonl"].trim().split("\n").map(JSON.parse);
  const m1 = records.find((r) => r.mch === "m1");
  assert.equal(m1.net, 700);
  assert.equal(m1.status, "final");
  assert.match(m1.cert, /^[0-9a-f]{64}$/);
});

test("CLI exits 2 with line number on invalid JSON", () => {
  const files = { "in.jsonl": `${ev({ type: "capture", id: "a", mch: "m", amt: 1, ts: 0 })}\nnot json\n` };
  const { io, stderrLines } = makeIo(files);
  const code = run(["settle", "--in", "in.jsonl", "--wm", "3000", "--out", "out.jsonl"], io);
  assert.equal(code, 2);
  assert.ok(stderrLines.some((l) => /line 2/.test(l)));
});

test("CLI exits 2 on non-integer or negative amt", () => {
  for (const amt of [10.5, -5]) {
    const files = { "in.jsonl": ev({ type: "capture", id: "a", mch: "m", amt, ts: 0 }) + "\n" };
    const { io, stderrLines } = makeIo(files);
    const code = run(["settle", "--in", "in.jsonl", "--wm", "3000", "--out", "out.jsonl"], io);
    assert.equal(code, 2, `amt=${amt}`);
    assert.ok(stderrLines.some((l) => /line 1/.test(l)));
  }
});

test("CLI writes CONFLICT inline and continues processing", () => {
  const files = {
    "in.jsonl": [
      ev({ type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1000 }),
      ev({ type: "capture", id: "c1", mch: "m1", amt: 500, ts: 2000 }),
      ev({ type: "capture", id: "c2", mch: "m1", amt: 100, ts: 3000 }),
    ].join("\n"),
  };
  const { io } = makeIo(files);
  const code = run(["settle", "--in", "in.jsonl", "--wm", "3000", "--out", "out.jsonl"], io);
  assert.equal(code, 0);
  const records = files["out.jsonl"].trim().split("\n").map(JSON.parse);
  assert.ok(records.some((r) => r.code === "CONFLICT" && r.line === 2));
  assert.equal(records.find((r) => r.status === "final").net, 600);
});

test("CLI rejects bad usage with exit 1", () => {
  const { io } = makeIo({});
  assert.equal(run([], io), 1);
  assert.equal(run(["settle", "--in", "x"], io), 1);
  assert.equal(run(["nope"], io), 1);
});

test("CLI --naive skips the check beyond 200 events", () => {
  const lines = [];
  for (let i = 0; i < 201; i++) lines.push(ev({ type: "capture", id: `t${i}`, mch: "m", amt: 1, ts: i * 1000 }));
  const files = { "in.jsonl": lines.join("\n") };
  const { io, stderrLines } = makeIo(files);
  const code = run(["settle", "--in", "in.jsonl", "--wm", "3000", "--out", "out.jsonl", "--naive"], io);
  assert.equal(code, 0);
  assert.ok(stderrLines.some((l) => /naive-check: skipped/.test(l)));
});

test("CLI runs end-to-end on real files", () => {
  const dir = mkdtempSync(join(tmpdir(), "settle-"));
  const inFile = join(dir, "in.jsonl");
  const outFile = join(dir, "out.jsonl");
  writeFileSync(inFile, ev({ type: "capture", id: "c1", mch: "m1", amt: 42, ts: 0 }) + "\n");
  const errs = [];
  const code = run(["settle", "--in", inFile, "--wm", "3000", "--out", outFile], { stderr: (m) => errs.push(m) });
  assert.equal(code, 0);
  const [rec] = readFileSync(outFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rec.net, 42);
});
