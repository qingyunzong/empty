import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { BadLineError, parseLine, sortJsonLines } from "../src/sorter";
import { runCli } from "../src/cli";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sortjson-test-"));
}

function writeJsonl(file: string, records: any[]): void {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function readJsonl(file: string): any[] {
  const content = fs.readFileSync(file, "utf8");
  if (content === "") return [];
  return content
    .trimEnd()
    .split("\n")
    .map((line: string) => JSON.parse(line));
}

// Deterministic pseudo-random records with duplicate small keys, negative keys,
// and bigint keys beyond Number.MAX_SAFE_INTEGER (as strings).
function randomRecords(n: number): any[] {
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const records = [];
  for (let i = 0; i < n; i++) {
    const choice = i % 3;
    let key: any;
    if (choice === 0) key = Math.floor(rand() * 10);
    else if (choice === 1) key = (BigInt("9007199254740993") + BigInt(Math.floor(rand() * 1000))).toString();
    else key = -(Math.floor(rand() * 4) + 1);
    records.push({ k: key, v: i });
  }
  return records;
}

function expectedStableSort(records: any[]): any[] {
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ka = BigInt(a.r.k);
      const kb = BigInt(b.r.k);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

test("low budget external sort matches in-memory stable sort", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  const tempDir = path.join(dir, "runs");
  const records = randomRecords(500);
  writeJsonl(input, records);

  await sortJsonLines({ inputPath: input, outputPath: output, keyField: "k", budget: 7, tempDir });

  assert.deepStrictEqual(readJsonl(output), expectedStableSort(records));
  // temp segments are cleaned up after a successful publish
  assert.deepStrictEqual(fs.readdirSync(tempDir), []);
});

test("stable: equal keys keep original input order", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  const records = Array.from({ length: 50 }, (_, i) => ({ k: "18446744073709551616", v: i }));
  writeJsonl(input, records);

  await sortJsonLines({ inputPath: input, outputPath: output, keyField: "k", budget: 3, tempDir: path.join(dir, "runs") });

  assert.deepStrictEqual(readJsonl(output), records);
});

test("bad JSON line aborts and publishes nothing", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  const tempDir = path.join(dir, "runs");
  fs.writeFileSync(input, '{"k":2}\nnot json\n{"k":1}\n');

  await assert.rejects(
    sortJsonLines({ inputPath: input, outputPath: output, keyField: "k", budget: 4, tempDir }),
    (err: any) => err instanceof BadLineError && err.lineNo === 2
  );
  assert.ok(!fs.existsSync(output), "output must not be published");
  assert.ok(!fs.readdirSync(dir).some((f: string) => f.startsWith("out.jsonl.tmp")), "temp output must be removed");
});

test("bad key lines abort: missing, float, non-integer string", async () => {
  for (const [line, lineNo] of [
    ['{"v":1}', 1],
    ['{"k":1.5}', 1],
    ['{"k":"12x"}', 1],
    ['{"k":1}\n{"k":"abc"}', 2],
    ['[1,2]', 1],
  ] as Array<[string, number]>) {
    const dir = makeTempDir();
    const input = path.join(dir, "in.jsonl");
    fs.writeFileSync(input, line + "\n");
    await assert.rejects(
      sortJsonLines({
        inputPath: input,
        outputPath: path.join(dir, "out.jsonl"),
        keyField: "k",
        budget: 4,
        tempDir: path.join(dir, "runs"),
      }),
      (err: any) => err instanceof BadLineError && err.lineNo === lineNo
    );
  }
});

test("parseLine accepts bigint strings beyond 2^53 exactly", () => {
  const rec = parseLine('{"k":"9007199254740993"}', 1, "k");
  assert.strictEqual(rec.key, 9007199254740993n);
  assert.strictEqual(rec.id, 0);
});

test("injected write failure: no publish, segments recoverable, rerun succeeds without input", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  const tempDir = path.join(dir, "runs");
  const records = randomRecords(120);
  writeJsonl(input, records);

  class FailingStream extends Writable {
    private seen = 0;
    constructor(private failAfter: number) {
      super();
    }
    _write(_chunk: any, _enc: any, cb: (err?: Error) => void): void {
      if (this.seen++ >= this.failAfter) cb(new Error("injected write failure"));
      else cb();
    }
  }

  await assert.rejects(
    sortJsonLines({
      inputPath: input,
      outputPath: output,
      keyField: "k",
      budget: 5,
      tempDir,
      createOutputStream: () => new FailingStream(3),
    }),
    /injected write failure/
  );
  assert.ok(!fs.existsSync(output), "failed run must not publish output");
  assert.ok(fs.existsSync(path.join(tempDir, "manifest.json")), "segments survive for recovery");

  // Remove the input entirely: recovery must merge the surviving segments only.
  fs.unlinkSync(input);
  await sortJsonLines({ inputPath: input, outputPath: output, keyField: "k", budget: 5, tempDir });

  assert.deepStrictEqual(readJsonl(output), expectedStableSort(records));
  assert.deepStrictEqual(fs.readdirSync(tempDir), [], "segments cleaned after success");
});

test("empty input produces empty output", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  fs.writeFileSync(input, "");
  await sortJsonLines({ inputPath: input, outputPath: output, keyField: "k", budget: 4, tempDir: path.join(dir, "runs") });
  assert.strictEqual(fs.readFileSync(output, "utf8"), "");
});

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const orig = console.error;
  let stderr = "";
  console.error = (...args: any[]) => {
    stderr += args.map(String).join(" ") + "\n";
  };
  try {
    const code = await fn();
    return { code, stderr };
  } finally {
    console.error = orig;
  }
}

test("CLI: sorts file with tiny budget, exit 0", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  const records = randomRecords(200);
  writeJsonl(input, records);

  const { code, stderr } = await captureStderr(() =>
    runCli(["-i", input, "-o", output, "-k", "k", "-b", "4", "-t", path.join(dir, "runs")])
  );
  assert.strictEqual(code, 0, stderr);
  assert.deepStrictEqual(readJsonl(output), expectedStableSort(records));
});

test("CLI: bad line exits 1 and publishes nothing", async () => {
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  fs.writeFileSync(input, '{"k":1}\n{broken}\n');

  const { code, stderr } = await captureStderr(() =>
    runCli(["-i", input, "-o", output, "-k", "k", "-b", "4", "-t", path.join(dir, "runs")])
  );
  assert.strictEqual(code, 1);
  assert.match(stderr, /bad input/);
  assert.ok(!fs.existsSync(output));
});

test("CLI: usage error exits 2", async () => {
  const { code } = await captureStderr(() => runCli(["-o", "x"]));
  assert.strictEqual(code, 2);
});

test("CLI: real process end-to-end (skipped when spawn is sandboxed)", async (t: any) => {
  const cli = path.join(__dirname, "..", "src", "cli.js");
  const dir = makeTempDir();
  const input = path.join(dir, "in.jsonl");
  const output = path.join(dir, "out.jsonl");
  const records = randomRecords(100);
  writeJsonl(input, records);

  const res = spawnSync(process.execPath, [cli, "-i", input, "-o", output, "-k", "k", "-b", "4", "-t", path.join(dir, "runs")], { encoding: "utf8" });
  if (res.error) {
    t.skip(`cannot spawn child process here: ${res.error.message}`);
    return;
  }
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(readJsonl(output), expectedStableSort(records));
});
