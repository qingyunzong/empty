import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { externalSort, BadLineError, parseLine, type SortStats } from "../src/sorter.js";
import { nodeIo, type Io } from "../src/io.js";
import { run as cliRun } from "../src/cli.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function makeWorkspace(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "sort-test-"));
}

async function writeInput(dir: string, lines: string[]): Promise<string> {
  const p = path.join(dir, "input.jsonl");
  await fsp.writeFile(p, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
  return p;
}

async function readOutputLines(p: string): Promise<string[]> {
  const content = await fsp.readFile(p, "utf8");
  return content.length === 0 ? [] : content.replace(/\n$/, "").split("\n");
}

/** Reference implementation: V8's Array.sort is stable, ties keep input order. */
function expectedSorted(lines: string[]): string[] {
  return lines
    .map((line, i) => ({ line, key: parseLine(line, i + 1, i).key }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.line);
}

type FailOp = "writeSegment" | "writeJson" | "streamWrite" | "rename";

interface FlakyIo extends Io {
  counts: Map<string, number>;
}

/** Io wrapper that fails the Nth invocation of a chosen operation. */
function flakyIo(shouldFail: (op: FailOp, p: string, n: number) => boolean): FlakyIo {
  const counts = new Map<string, number>();
  const bump = (op: string): number => {
    const n = (counts.get(op) ?? 0) + 1;
    counts.set(op, n);
    return n;
  };
  return {
    counts,
    mkdir: (dir) => nodeIo.mkdir(dir),
    exists: (p) => nodeIo.exists(p),
    stat: (p) => nodeIo.stat(p),
    readJson: (p) => nodeIo.readJson(p),
    readLines: (p) => nodeIo.readLines(p),
    remove: (p) => nodeIo.remove(p),
    removeDir: (p) => nodeIo.removeDir(p),
    async writeJsonAtomic(p, value) {
      const n = bump("writeJson");
      if (shouldFail("writeJson", p, n)) throw new Error(`injected writeJson failure #${n}`);
      return nodeIo.writeJsonAtomic(p, value);
    },
    async writeLinesAtomic(p, lines) {
      const n = bump("writeSegment");
      if (shouldFail("writeSegment", p, n)) throw new Error(`injected writeSegment failure #${n}`);
      return nodeIo.writeLinesAtomic(p, lines);
    },
    createWriter(p) {
      const inner = nodeIo.createWriter(p);
      return {
        async write(line) {
          const n = bump("streamWrite");
          if (shouldFail("streamWrite", p, n)) throw new Error(`injected streamWrite failure #${n}`);
          return inner.write(line);
        },
        close: () => inner.close(),
      };
    },
    async rename(from, to) {
      const n = bump("rename");
      if (shouldFail("rename", from, n)) throw new Error(`injected rename failure #${n}`);
      return nodeIo.rename(from, to);
    },
  };
}

function sortArgs(input: string, output: string, tmpDir: string, budget: number) {
  return { input, output, tmpDir, budget };
}

// ---------------------------------------------------------------------------
// correctness
// ---------------------------------------------------------------------------

test("low budget matches in-memory stable sort", async () => {
  const dir = await makeWorkspace();
  const rand = mulberry32(42);
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    const kind = rand();
    let key: number | string;
    if (kind < 0.4) {
      key = Math.floor(rand() * 20); // small range -> many duplicate keys
    } else if (kind < 0.7) {
      // beyond Number.MAX_SAFE_INTEGER, must be carried as a string
      key = (BigInt(Math.floor(rand() * 1e15)) * 1000003n + BigInt(i)).toString();
    } else {
      key = -Math.floor(rand() * 1e6);
    }
    lines.push(JSON.stringify({ id: i, key, payload: `row-${i}` }));
  }
  const input = await writeInput(dir, lines);
  const output = path.join(dir, "out.jsonl");
  const tmpDir = path.join(dir, "segments");

  const stats: SortStats = await externalSort(sortArgs(input, output, tmpDir, 7));

  assert.equal(stats.records, 600);
  assert.ok(stats.segments > 1, "expected multiple spilled segments at budget 7");
  assert.deepEqual(await readOutputLines(output), expectedSorted(lines));
  assert.equal(await nodeIo.exists(tmpDir), false, "temp dir removed after success");
});

test("stable: equal keys keep original input id order", async () => {
  const dir = await makeWorkspace();
  const lines = [
    '{"id":"a","key":5}',
    '{"id":"b","key":3}',
    '{"id":"c","key":5}',
    '{"id":"d","key":3}',
    '{"id":"e","key":5}',
    '{"id":"f","key":3}',
  ];
  const input = await writeInput(dir, lines);
  const output = path.join(dir, "out.jsonl");

  await externalSort(sortArgs(input, output, path.join(dir, "seg"), 2));

  const ids = (await readOutputLines(output)).map((l) => (JSON.parse(l) as { id: string }).id);
  assert.deepEqual(ids, ["b", "d", "f", "a", "c", "e"]);
});

test("bigint keys beyond 2^53 sort exactly", async () => {
  const dir = await makeWorkspace();
  const keys = [
    "9007199254740993", // 2^53 + 1, indistinguishable from 2^53 as a double
    "9007199254740992", // 2^53
    "-170141183460469231731687303715884105728",
    "170141183460469231731687303715884105727",
    "0",
    "-1",
  ];
  const lines = keys.map((k, i) => JSON.stringify({ id: i, key: k }));
  const input = await writeInput(dir, lines);
  const output = path.join(dir, "out.jsonl");

  await externalSort(sortArgs(input, output, path.join(dir, "seg"), 3));

  const sortedKeys = (await readOutputLines(output)).map(
    (l) => (JSON.parse(l) as { key: string }).key
  );
  assert.deepEqual(sortedKeys, [
    "-170141183460469231731687303715884105728",
    "-1",
    "0",
    "9007199254740992",
    "9007199254740993",
    "170141183460469231731687303715884105727",
  ]);
});

test("budget larger than input sorts in a single run", async () => {
  const dir = await makeWorkspace();
  const lines = ["5", "1", "4", "1", "5", "9", "2", "6"].map((k, i) =>
    JSON.stringify({ id: i, key: Number(k) })
  );
  const input = await writeInput(dir, lines);
  const output = path.join(dir, "out.jsonl");

  const stats = await externalSort(sortArgs(input, output, path.join(dir, "seg"), 1000));

  assert.equal(stats.segments, 1);
  assert.equal(stats.mergePasses, 0);
  assert.deepEqual(await readOutputLines(output), expectedSorted(lines));
});

test("empty input produces an empty output file", async () => {
  const dir = await makeWorkspace();
  const input = await writeInput(dir, []);
  const output = path.join(dir, "out.jsonl");

  const stats = await externalSort(sortArgs(input, output, path.join(dir, "seg"), 4));

  assert.equal(stats.records, 0);
  assert.equal(await fsp.readFile(output, "utf8"), "");
});

// ---------------------------------------------------------------------------
// bad input lines: abort, publish nothing
// ---------------------------------------------------------------------------

test("bad lines abort with line number and publish no output", async () => {
  const badLines = [
    '{"id": 2, "key": ', // truncated JSON
    '{"id": 2}', // missing key
    '{"id": 2, "key": 1.5}', // non-integer number
    '{"id": 2, "key": "abc"}', // non-integer string
    "[1, 2, 3]", // not an object
  ];
  for (const bad of badLines) {
    const dir = await makeWorkspace();
    const lines = ['{"id":0,"key":1}', '{"id":1,"key":2}', bad, '{"id":3,"key":3}'];
    const input = await writeInput(dir, lines);
    const output = path.join(dir, "out.jsonl");

    await assert.rejects(
      externalSort(sortArgs(input, output, path.join(dir, "seg"), 2)),
      (err: unknown) => {
        if (!(err instanceof BadLineError)) return false;
        return err.lineNo === 3 && /line 3/.test(err.message);
      }
    );
    assert.equal(await nodeIo.exists(output), false, `no output published for: ${bad}`);
    assert.equal(await nodeIo.exists(output + ".tmp"), false, "no partial tmp output left");
  }
});

// ---------------------------------------------------------------------------
// failure injection and resume
// ---------------------------------------------------------------------------

test("segment write failure aborts; resume reuses spilled segments", async () => {
  const dir = await makeWorkspace();
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ id: i, key: 10 - i }));
  const input = await writeInput(dir, lines);
  const output = path.join(dir, "out.jsonl");
  const tmpDir = path.join(dir, "seg");

  // budget 3 over 10 records -> 4 segment writes; kill the 2nd.
  const crashing = flakyIo((op, _p, n) => op === "writeSegment" && n === 2);
  await assert.rejects(externalSort({ ...sortArgs(input, output, tmpDir, 3), io: crashing }));
  assert.equal(await nodeIo.exists(output), false);

  const manifest = JSON.parse(
    await fsp.readFile(path.join(tmpDir, "manifest.json"), "utf8")
  ) as { segments: string[]; nextLine: number; inputDone: boolean };
  assert.equal(manifest.segments.length, 1, "first segment survived the crash");
  assert.equal(manifest.nextLine, 3);
  assert.equal(manifest.inputDone, false);

  const healthy = flakyIo(() => false);
  const stats = await externalSort({
    ...sortArgs(input, output, tmpDir, 3),
    resume: true,
    io: healthy,
  });

  assert.equal(stats.resumed, true);
  assert.equal(
    healthy.counts.get("writeSegment"),
    3,
    "only the remaining runs are spilled, segment 0 is reused"
  );
  assert.deepEqual(await readOutputLines(output), expectedSorted(lines));
  assert.equal(await nodeIo.exists(tmpDir), false, "temp dir removed after success");
});

test("output write failure publishes nothing; resume finishes from temp segments", async () => {
  const dir = await makeWorkspace();
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ id: i, key: (i * 7) % 10 }));
  const input = await writeInput(dir, lines);
  const output = path.join(dir, "out.jsonl");
  const tmpDir = path.join(dir, "seg");

  // Fail writes into the final output stream.
  const crashing = flakyIo((op, p) => op === "streamWrite" && p === output + ".tmp");
  await assert.rejects(externalSort({ ...sortArgs(input, output, tmpDir, 3), io: crashing }));

  assert.equal(await nodeIo.exists(output), false, "no output published");
  assert.equal(await nodeIo.exists(output + ".tmp"), false, "partial tmp output removed");
  assert.equal(await nodeIo.exists(tmpDir), true, "temp segments kept for resume");

  const healthy = flakyIo(() => false);
  const stats = await externalSort({
    ...sortArgs(input, output, tmpDir, 3),
    resume: true,
    io: healthy,
  });

  assert.equal(stats.resumed, true);
  assert.equal(
    healthy.counts.get("writeSegment") ?? 0,
    0,
    "input is not re-read; merge resumes from temp segments"
  );
  assert.deepEqual(await readOutputLines(output), expectedSorted(lines));
});

// ---------------------------------------------------------------------------
// CLI end to end
// ---------------------------------------------------------------------------

test("CLI sorts a file and rejects bad input without publishing", async () => {
  const dir = await makeWorkspace();
  const capture = () => {
    const chunks: string[] = [];
    return { chunks, stream: { write: (s: string) => void chunks.push(s) } };
  };

  const good = await writeInput(dir, [
    '{"id":0,"key":9}',
    '{"id":1,"key":1}',
    '{"id":2,"key":9}',
    '{"id":3,"key":-4}',
  ]);
  const goodOut = path.join(dir, "sorted.jsonl");
  const okOut = capture();
  const okErr = capture();
  const okStatus = await cliRun(
    ["--input", good, "--output", goodOut, "--budget", "2", "--tmp-dir", path.join(dir, "seg")],
    okOut.stream,
    okErr.stream
  );
  assert.equal(okStatus, 0, okErr.chunks.join(""));
  assert.match(okOut.chunks.join(""), /sorted 4 record\(s\)/);
  const ids = (await readOutputLines(goodOut)).map((l) => (JSON.parse(l) as { id: number }).id);
  assert.deepEqual(ids, [3, 1, 0, 2]);

  const badDir = await makeWorkspace();
  const bad = await writeInput(badDir, ['{"id":0,"key":1}', "not json", '{"id":2,"key":2}']);
  const badOut = path.join(badDir, "sorted.jsonl");
  const failOut = capture();
  const failErr = capture();
  const failStatus = await cliRun(
    ["--input", bad, "--output", badOut, "--budget", "2", "--tmp-dir", path.join(badDir, "seg")],
    failOut.stream,
    failErr.stream
  );
  assert.equal(failStatus, 1);
  assert.match(failErr.chunks.join(""), /line 2/);
  assert.equal(await nodeIo.exists(badOut), false, "CLI publishes nothing on bad input");
});
