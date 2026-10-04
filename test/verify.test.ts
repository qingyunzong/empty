import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyDataset, exitCodeFor, minimalConflictPairs } from "../src/verify.js";
import { locateField } from "../src/locate.js";
import { FIELDS, SOURCES, SOURCE_FILES, FieldName, SourceName } from "../src/model.js";

// Deterministic RNG (mulberry32) so 随机篡改 acceptance is reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  itemId: string;
  runId: string;
  problemSummary: string;
  stageSource: string;
}

function makeItems(n: number): Item[] {
  const items: Item[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `item-${String(i).padStart(3, "0")}`;
    items.push({
      itemId: id,
      runId: `run-2026-10-05-${i}`,
      problemSummary: `题面摘要: problem ${i} asks for a verifier`,
      stageSource: `stage-${(i % 3) + 1}/generator`,
    });
  }
  return items;
}

function writeDataset(dir: string, perSource: Record<SourceName, Item[]>): void {
  for (const s of SOURCES) {
    const body = perSource[s].map((it) => JSON.stringify(it)).join("\n") + "\n";
    writeFileSync(join(dir, SOURCE_FILES[s]), body);
  }
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "evverify-"));
}

function consistentDataset(n: number): Record<SourceName, Item[]> {
  const items = makeItems(n);
  return {
    manifest: items.map((i) => ({ ...i })),
    trajectory: items.map((i) => ({ ...i })),
    filesummary: items.map((i) => ({ ...i })),
  };
}

const HERE = fileURLToPath(import.meta.url);
const CLI = join(HERE, "..", "..", "src", "cli.js");

describe("golden dataset", () => {
  test("fully consistent dataset yields all-consistent and exit 0", () => {
    const dir = freshDir();
    writeDataset(dir, consistentDataset(5));
    const report = verifyDataset(dir);
    assert.equal(report.summary.total, 5);
    assert.equal(report.summary.consistent, 5);
    assert.equal(report.summary.unknown, 0);
    assert.equal(report.summary.conflict, 0);
    assert.equal(report.issues.length, 0);
    assert.equal(exitCodeFor(report), 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("删项 (item deletion) acceptance", () => {
  test("deleting an item from one source marks it unknown, not conflict", () => {
    const dir = freshDir();
    const data = consistentDataset(4);
    data.trajectory = data.trajectory.filter((i) => i.itemId !== "item-002");
    writeDataset(dir, data);
    const report = verifyDataset(dir);
    const item = report.items.find((i) => i.itemId === "item-002")!;
    assert.equal(item.status, "unknown");
    assert.deepEqual(item.missingFrom, ["trajectory"]);
    assert.equal(item.conflictPairs.length, 0);
    assert.ok(item.issues.some((i) => i.kind === "missing-item"));
    // untouched items stay consistent
    assert.equal(report.summary.consistent, 3);
    assert.equal(report.summary.unknown, 1);
    assert.equal(report.summary.conflict, 0);
    assert.equal(exitCodeFor(report), 2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("deleting a whole source file marks every item unknown", () => {
    const dir = freshDir();
    writeDataset(dir, consistentDataset(3));
    rmSync(join(dir, SOURCE_FILES.trajectory));
    const report = verifyDataset(dir);
    assert.equal(report.summary.unknown, 3);
    assert.equal(report.summary.conflict, 0);
    assert.ok(report.issues.some((i) => i.kind === "parse-error"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("随机篡改 (random tampering) acceptance", () => {
  test("tampering a random field is always detected with a citing conflict pair", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const dir = freshDir();
      const data = consistentDataset(6);
      const src = SOURCES[Math.floor(rand() * SOURCES.length)]!;
      const field = FIELDS[Math.floor(rand() * FIELDS.length)]!;
      const victim = Math.floor(rand() * 6);
      const tamperedValue = `TAMPERED-seed${seed}`;
      data[src][victim]![field] = tamperedValue;
      writeDataset(dir, data);

      const report = verifyDataset(dir);
      assert.equal(report.summary.conflict, 1, `seed=${seed}`);
      assert.equal(report.summary.consistent, 5, `seed=${seed}`);
      const itemId = `item-${String(victim + 1).padStart(3, "0")}`;
      const item = report.items.find((i) => i.itemId === itemId)!;
      assert.equal(item.status, "conflict");
      // exactly one minimal pair (2 value-groups) for the tampered field only
      assert.equal(item.conflictPairs.length, 1, `seed=${seed}`);
      const pair = item.conflictPairs[0]!;
      assert.equal(pair.field, field);
      // the pair must cite the tampered record and one contradicting record
      const tamperedSide = [pair.a, pair.b].find(
        (e) => e.citation.source === src && e.value === tamperedValue
      );
      assert.ok(tamperedSide, `seed=${seed}: pair must cite tampered evidence`);
      assert.equal(tamperedSide.citation.line, victim + 1);
      // citation range must slice exactly to the JSON-encoded tampered value
      const rawLine = readFileSync(tamperedSide.citation.file, "utf8").split("\n")[
        tamperedSide.citation.line - 1
      ]!;
      const slice = rawLine.slice(
        tamperedSide.citation.colStart - 1,
        tamperedSide.citation.colEnd - 1
      );
      assert.equal(slice, JSON.stringify(tamperedValue), `seed=${seed}`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tampering each checked field (runId/题面摘要/阶段来源) is caught", () => {
    for (const field of FIELDS) {
      const dir = freshDir();
      const data = consistentDataset(2);
      data.filesummary[0]![field] = "WRONG";
      writeDataset(dir, data);
      const report = verifyDataset(dir);
      const item = report.items.find((i) => i.itemId === "item-001")!;
      assert.equal(item.status, "conflict", field);
      assert.equal(item.conflictPairs.length, 1);
      assert.equal(item.conflictPairs[0]!.field, field);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("three distinct values yield three minimal pairs (all group pairs)", () => {
    const dir = freshDir();
    const data = consistentDataset(1);
    data.manifest[0]!.runId = "run-A";
    data.trajectory[0]!.runId = "run-B";
    data.filesummary[0]!.runId = "run-C";
    writeDataset(dir, data);
    const report = verifyDataset(dir);
    const item = report.items[0]!;
    assert.equal(item.conflictPairs.length, 3);
    const values = new Set(
      item.conflictPairs.flatMap((p) => [p.a.value, p.b.value])
    );
    assert.deepEqual([...values].sort(), ["run-A", "run-B", "run-C"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("citation ranges (引用范围)", () => {
  test("locateField slices the exact JSON string token", () => {
    const line = JSON.stringify({
      itemId: "x",
      runId: 'esc"aped\\value',
      problemSummary: "摘要",
    });
    for (const f of ["itemId", "runId", "problemSummary"]) {
      const span = locateField(line, f)!;
      assert.ok(span);
      const token = line.slice(span.colStart - 1, span.colEnd - 1);
      assert.equal(JSON.parse(token), (JSON.parse(line) as Record<string, string>)[f]);
    }
    assert.equal(locateField(line, "nope"), null);
  });
});

describe("CLI end-to-end", () => {
  // The sandbox drops piped child stdout, so redirect to a temp file.
  function runCli(dir: string): { status: number | null; stdout: string } {
    const outFile = join(dir, "cli-out.txt");
    const fd = openSync(outFile, "w");
    const r = spawnSync(process.execPath, [CLI, dir], {
      stdio: ["ignore", fd, "ignore"],
    });
    closeSync(fd);
    return { status: r.status, stdout: readFileSync(outFile, "utf8") };
  }

  test("exit 0 on consistent, 2 on unknown, 1 on conflict", () => {
    const dir = freshDir();
    writeDataset(dir, consistentDataset(3));
    assert.equal(runCli(dir).status, 0);

    const data2 = consistentDataset(3);
    data2.filesummary = data2.filesummary.filter((i) => i.itemId !== "item-001");
    writeDataset(dir, data2);
    const unknownRun = runCli(dir);
    assert.equal(unknownRun.status, 2);
    assert.match(unknownRun.stdout, /\[unknown\] item-001/);

    const data3 = consistentDataset(3);
    data3.trajectory[1]!.stageSource = "stage-99/tampered";
    writeDataset(dir, data3);
    const conflictRun = runCli(dir);
    assert.equal(conflictRun.status, 1);
    assert.match(conflictRun.stdout, /\[conflict\] item-002/);
    assert.match(conflictRun.stdout, /minimal conflict pairs/);
    assert.match(conflictRun.stdout, /trajectory\.jsonl:2:/);
    rmSync(dir, { recursive: true, force: true });
  });
});
