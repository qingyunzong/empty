import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

test("CLI solves the bundled example and verifies it exhaustively", () => {
  const example = new URL("../../examples/sample.json", import.meta.url).pathname;
  const r = run(["solve", example]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /optimal: profit=\d+ area=\d+/);
  assert.match(r.out, /verify: OK \(exhaustive/);
  assert.match(r.out, /#/); // forbidden cells rendered in the certificate grid
});

test("CLI --json emits a machine-readable certificate and --out writes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rectpack-"));
  const instPath = join(dir, "inst.json");
  writeFileSync(instPath, JSON.stringify({
    grid: { width: 3, height: 2, forbidden: [[1, 0]] },
    items: [
      { id: "A", w: 1, h: 2, profit: 4, rotate: true },
      { id: "B", w: 2, h: 1, profit: 3 },
    ],
  }));
  const certPath = join(dir, "cert.json");
  const r = run(["solve", instPath, "--json", "--out", certPath]);
  assert.equal(r.code, 0, r.err);
  const cert = JSON.parse(r.out);
  assert.equal(cert.grid.width, 3);
  assert.ok(cert.profit >= 4);
  assert.ok(Array.isArray(cert.placements));
  assert.deepEqual(JSON.parse(readFileSync(certPath, "utf8")), cert);
});

test("CLI exits non-zero on invalid input and on missing args", () => {
  const dir = mkdtempSync(join(tmpdir(), "rectpack-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ grid: { width: 10, height: 10 }, items: [] }));
  const r1 = run(["solve", bad]);
  assert.notEqual(r1.code, 0);
  assert.match(r1.err, /grid/);
  const r2 = run([]);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /usage/);
});

test("CLI verify command runs the exhaustive check", () => {
  const example = new URL("../../examples/sample.json", import.meta.url).pathname;
  const r = run(["verify", example]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /verify: OK \(exhaustive/);
});
