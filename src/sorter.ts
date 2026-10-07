import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";

export interface SortRecord {
  id: number; // input order index, guarantees stability
  key: bigint;
  line: string; // original raw input line
}

export class BadLineError extends Error {
  readonly lineNo: number;
  constructor(lineNo: number, reason: string) {
    super(`line ${lineNo}: ${reason}`);
    this.name = "BadLineError";
    this.lineNo = lineNo;
  }
}

const INTEGER_RE = /^-?\d+$/;

export function parseLine(line: string, lineNo: number, keyField: string): SortRecord {
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    throw new BadLineError(lineNo, "invalid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadLineError(lineNo, "expected a JSON object");
  }
  const raw = value[keyField];
  let key: bigint;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new BadLineError(lineNo, `key "${keyField}" is not an integer`);
    }
    key = BigInt(raw);
  } else if (typeof raw === "string" && INTEGER_RE.test(raw)) {
    key = BigInt(raw);
  } else {
    throw new BadLineError(lineNo, `key "${keyField}" is missing or not an integer`);
  }
  return { id: lineNo - 1, key, line };
}

export function compareRecords(a: { key: bigint; id: number }, b: { key: bigint; id: number }): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return a.id - b.id; // stable: ties keep input order
}

class MinHeap<T> {
  private items: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.cmp(items[left], items[smallest]) < 0) smallest = left;
        if (right < items.length && this.cmp(items[right], items[smallest]) < 0) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

async function writeChunk(out: any, chunk: string): Promise<void> {
  if (out.write(chunk)) return;
  await Promise.race([
    once(out, "drain"),
    once(out, "error").then(([err]: any[]) => {
      throw err;
    }),
  ]);
}

function encodeRunRecord(rec: SortRecord): string {
  return JSON.stringify({ id: rec.id, key: rec.key.toString(), line: rec.line });
}

function decodeRunRecord(line: string): SortRecord {
  const raw = JSON.parse(line);
  return { id: raw.id, key: BigInt(raw.key), line: raw.line };
}

const MANIFEST = "manifest.json";

function manifestPath(tempDir: string): string {
  return path.join(tempDir, MANIFEST);
}

function saveManifest(tempDir: string, runs: string[]): void {
  const tmp = manifestPath(tempDir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ runs }));
  fs.renameSync(tmp, manifestPath(tempDir));
}

// Loads the manifest and removes stale segment files left behind by a crashed pass.
export function loadManifest(tempDir: string): string[] | null {
  if (!fs.existsSync(manifestPath(tempDir))) return null;
  const data = JSON.parse(fs.readFileSync(manifestPath(tempDir), "utf8"));
  const runs: string[] = data.runs;
  const keep = new Set([...runs, MANIFEST]);
  for (const entry of fs.readdirSync(tempDir)) {
    if (!keep.has(entry) && entry.endsWith(".jsonl")) {
      fs.unlinkSync(path.join(tempDir, entry));
    }
  }
  return runs;
}

async function writeRunFile(records: SortRecord[], runPath: string): Promise<void> {
  const tmp = runPath + ".tmp";
  const out = fs.createWriteStream(tmp, { encoding: "utf8" });
  try {
    for (const rec of records) {
      await writeChunk(out, encodeRunRecord(rec) + "\n");
    }
    out.end();
    await finished(out);
    fs.renameSync(tmp, runPath);
  } catch (err) {
    out.destroy();
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Phase 1: buffer up to `budget` records, sort in memory, flush as a run segment.
// The manifest is updated after every segment so a crash can resume merging.
export async function generateRuns(
  lines: AsyncIterable<string>,
  opts: { keyField: string; budget: number; tempDir: string }
): Promise<string[]> {
  const runs: string[] = [];
  let buffer: SortRecord[] = [];
  let lineNo = 0;
  let runIndex = 0;
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    buffer.sort(compareRecords);
    const name = `run-${String(runIndex).padStart(6, "0")}.jsonl`;
    runIndex += 1;
    await writeRunFile(buffer, path.join(opts.tempDir, name));
    runs.push(name);
    saveManifest(opts.tempDir, runs);
    buffer = [];
  };
  for await (const line of lines) {
    lineNo += 1;
    buffer.push(parseLine(line, lineNo, opts.keyField));
    if (buffer.length >= opts.budget) await flush();
  }
  await flush();
  return runs;
}

interface Cursor extends SortRecord {
  iter: AsyncIterator<string>;
}

// k-way merge of run files; emits records in (key, id) order.
async function mergeRunFiles(runPaths: string[], sink: (rec: SortRecord) => Promise<void>): Promise<void> {
  const heap = new MinHeap<Cursor>(compareRecords);
  const iters: AsyncIterator<string>[] = [];
  try {
    for (const p of runPaths) {
      const rl = readline.createInterface({
        input: fs.createReadStream(p, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      const iter: AsyncIterator<string> = rl[Symbol.asyncIterator]();
      iters.push(iter);
      const first = await iter.next();
      if (!first.done) {
        heap.push({ ...decodeRunRecord(first.value), iter });
      }
    }
    while (heap.size > 0) {
      const cur = heap.pop()!;
      await sink({ id: cur.id, key: cur.key, line: cur.line });
      const next = await cur.iter.next();
      if (!next.done) {
        const rec = decodeRunRecord(next.value);
        cur.id = rec.id;
        cur.key = rec.key;
        cur.line = rec.line;
        heap.push(cur);
      }
    }
  } finally {
    for (const iter of iters) {
      try {
        await iter.return?.();
      } catch {}
    }
  }
}

async function mergeIntoRunFile(batchPaths: string[], outPath: string): Promise<void> {
  const tmp = outPath + ".tmp";
  const out = fs.createWriteStream(tmp, { encoding: "utf8" });
  try {
    await mergeRunFiles(batchPaths, async (rec) => {
      await writeChunk(out, encodeRunRecord(rec) + "\n");
    });
    out.end();
    await finished(out);
    fs.renameSync(tmp, outPath);
  } catch (err) {
    out.destroy();
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Phase 2: multi-pass merge. Each pass merges at most `fanIn` runs so the number
// of resident records stays bounded by the budget. The manifest is updated after
// every pass; superseded segments are deleted only after the manifest is safe.
export async function mergeAll(
  runNames: string[],
  tempDir: string,
  fanIn: number,
  sink: (rec: SortRecord) => Promise<void>
): Promise<void> {
  let current = runNames;
  let pass = 0;
  while (current.length > fanIn) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += fanIn) {
      const batch = current.slice(i, i + fanIn);
      if (batch.length === 1) {
        next.push(batch[0]);
        continue;
      }
      const name = `run-m${pass}-${String(next.length).padStart(6, "0")}.jsonl`;
      await mergeIntoRunFile(
        batch.map((n) => path.join(tempDir, n)),
        path.join(tempDir, name)
      );
      next.push(name);
    }
    saveManifest(tempDir, next);
    for (const name of current) {
      if (!next.includes(name)) {
        try {
          fs.unlinkSync(path.join(tempDir, name));
        } catch {}
      }
    }
    current = next;
    pass += 1;
  }
  await mergeRunFiles(
    current.map((n) => path.join(tempDir, n)),
    sink
  );
}

export interface SortFileOptions {
  inputPath: string; // "-" reads stdin
  outputPath: string; // "-" writes stdout (no atomic publish possible)
  keyField: string;
  budget: number; // max resident records
  tempDir: string;
  createOutputStream?: (tmpPath: string) => any; // injectable for failure tests
}

export async function sortJsonLines(opts: SortFileOptions): Promise<void> {
  if (!Number.isInteger(opts.budget) || opts.budget < 2) {
    throw new Error("budget must be an integer >= 2");
  }
  fs.mkdirSync(opts.tempDir, { recursive: true });

  let runs = loadManifest(opts.tempDir);
  if (runs === null) {
    const input =
      opts.inputPath === "-"
        ? process.stdin
        : fs.createReadStream(opts.inputPath, { encoding: "utf8" });
    const lines: AsyncIterable<string> = readline.createInterface({ input, crlfDelay: Infinity });
    runs = await generateRuns(lines, opts);
  }

  const toStdout = opts.outputPath === "-";
  const tmpOutput = toStdout ? null : `${opts.outputPath}.tmp-${process.pid}`;
  const out = opts.createOutputStream
    ? opts.createOutputStream(tmpOutput ?? opts.outputPath)
    : toStdout
      ? process.stdout
      : fs.createWriteStream(tmpOutput!, { encoding: "utf8" });

  try {
    await mergeAll(runs, opts.tempDir, opts.budget, async (rec) => {
      await writeChunk(out, rec.line + "\n");
    });
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    if (tmpOutput) {
      try {
        fs.unlinkSync(tmpOutput);
      } catch {}
    }
    throw err; // run segments + manifest are kept for recovery
  }

  // Publish atomically only after the merge fully succeeded.
  if (tmpOutput) fs.renameSync(tmpOutput, opts.outputPath);

  for (const entry of fs.readdirSync(opts.tempDir)) {
    if (entry.endsWith(".jsonl")) {
      try {
        fs.unlinkSync(path.join(opts.tempDir, entry));
      } catch {}
    }
  }
  try {
    fs.unlinkSync(manifestPath(opts.tempDir));
  } catch {}
}
