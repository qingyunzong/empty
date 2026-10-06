import * as path from "node:path";
import { nodeIo, type Io, type LineWriter } from "./io.js";

/** Thrown when an input line cannot be parsed or has no valid bigint key. */
export class BadLineError extends Error {
  readonly lineNo: number;
  constructor(lineNo: number, reason: string) {
    super(`invalid input at line ${lineNo}: ${reason}`);
    this.name = "BadLineError";
    this.lineNo = lineNo;
  }
}

export interface SortOptions {
  /** Path to the JSONL input file. */
  input: string;
  /** Path of the sorted JSONL output file (published atomically). */
  output: string;
  /** Memory budget: maximum number of records held resident at any time. */
  budget: number;
  /** Directory for temp run segments and the resume manifest. */
  tmpDir: string;
  /** Reuse temp segments/manifest from a previous interrupted run. */
  resume?: boolean;
  /** IO implementation; defaults to the real file system. */
  io?: Io;
}

export interface SortStats {
  records: number;
  segments: number;
  mergePasses: number;
  resumed: boolean;
}

interface Manifest {
  version: 1;
  input: string;
  size: number;
  mtimeMs: number;
  budget: number;
  /** Number of input lines already consumed into segments. */
  nextLine: number;
  inputDone: boolean;
  /** Segment file names (inside tmpDir) that still need merging. */
  segments: string[];
}

interface Rec {
  seq: number;
  key: bigint;
  line: string;
}

function parseKey(value: unknown): bigint {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`key must be an integer number or an integer string, got ${JSON.stringify(value)}`);
}

/** Parse one input line into a record; the original line is kept verbatim. */
export function parseLine(line: string, lineNo: number, seq: number): Rec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new BadLineError(lineNo, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("key" in parsed)) {
    throw new BadLineError(lineNo, 'missing "key" field');
  }
  let key: bigint;
  try {
    key = parseKey((parsed as { key: unknown }).key);
  } catch (err) {
    throw new BadLineError(lineNo, (err as Error).message);
  }
  return { seq, key, line };
}

/** Total order: bigint key ascending, ties broken by input position (stable). */
function compareRecs(a: Rec, b: Rec): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return a.seq - b.seq;
}

function serializeRec(r: Rec): string {
  return JSON.stringify({ s: r.seq, k: r.key.toString(), l: r.line });
}

function deserializeRec(line: string): Rec {
  const j = JSON.parse(line) as { s: number; k: string; l: string };
  return { seq: j.s, key: BigInt(j.k), line: j.l };
}

interface HeapItem {
  key: bigint;
  seq: number;
  line: string;
  src: number;
}

function heapLess(a: HeapItem, b: HeapItem): boolean {
  return a.key < b.key || (a.key === b.key && a.seq < b.seq);
}

class MinHeap {
  private items: HeapItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: HeapItem): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!heapLess(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): HeapItem | undefined {
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
        if (left < items.length && heapLess(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && heapLess(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

async function generateRuns(
  io: Io,
  budget: number,
  input: string,
  tmpDir: string,
  manifest: Manifest,
  manifestPath: string
): Promise<void> {
  let buffer: Rec[] = [];
  let lineNo = 0;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    buffer.sort(compareRecs);
    const name = `seg-${String(manifest.segments.length).padStart(5, "0")}.jsonl`;
    await io.writeLinesAtomic(path.join(tmpDir, name), buffer.map(serializeRec));
    manifest.segments.push(name);
    manifest.nextLine = lineNo;
    // Manifest is written after the segment, so a crash never points at a
    // segment that does not exist yet.
    await io.writeJsonAtomic(manifestPath, manifest);
    buffer = [];
  };

  for await (const line of io.readLines(input)) {
    lineNo += 1;
    if (lineNo <= manifest.nextLine) continue; // already spilled by a previous run
    buffer.push(parseLine(line, lineNo, lineNo - 1));
    if (buffer.length >= budget) await flush();
  }
  await flush();
  manifest.inputDone = true;
  await io.writeJsonAtomic(manifestPath, manifest);
}

async function mergeGroup(
  io: Io,
  tmpDir: string,
  group: string[],
  writer: LineWriter,
  envelope: boolean
): Promise<void> {
  const readers = group.map((name) =>
    io.readLines(path.join(tmpDir, name))[Symbol.asyncIterator]()
  );
  const heap = new MinHeap();

  const advance = async (src: number): Promise<void> => {
    const next = await readers[src]!.next();
    if (next.done) return;
    const rec = deserializeRec(next.value);
    heap.push({ key: rec.key, seq: rec.seq, line: rec.line, src });
  };

  for (let i = 0; i < readers.length; i++) await advance(i);
  while (heap.size > 0) {
    const item = heap.pop()!;
    // Intermediate segments keep the {s,k,l} envelope so later passes (and
    // resumes) can recover key and sequence; the final output is raw lines.
    await writer.write(
      envelope ? serializeRec({ seq: item.seq, key: item.key, line: item.line }) : item.line
    );
    await advance(item.src);
  }
}

async function mergeRuns(
  io: Io,
  tmpDir: string,
  manifest: Manifest,
  manifestPath: string,
  budget: number,
  output: string
): Promise<number> {
  // The merge heap holds at most one record per open segment, so fan-in is
  // capped by the same resident-record budget as run generation.
  const fanIn = Math.max(2, budget);
  let current = manifest.segments.slice();
  let passes = 0;

  while (current.length > fanIn) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += fanIn) {
      const group = current.slice(i, i + fanIn);
      if (group.length === 1) {
        next.push(group[0]!);
        continue;
      }
      const name = `merge-${passes}-${String(next.length).padStart(5, "0")}.jsonl`;
      const outPath = path.join(tmpDir, name);
      const tmpPath = outPath + ".tmp";
      const writer = io.createWriter(tmpPath);
      try {
        await mergeGroup(io, tmpDir, group, writer, true);
        await writer.close();
      } catch (err) {
        await io.remove(tmpPath);
        throw err;
      }
      await io.rename(tmpPath, outPath);
      for (const g of group) await io.remove(path.join(tmpDir, g));
      next.push(name);
    }
    current = next;
    passes += 1;
    // Persist merge progress so an interrupted merge resumes from the
    // surviving segments instead of re-reading the input.
    manifest.segments = current;
    await io.writeJsonAtomic(manifestPath, manifest);
  }

  // Final pass: merge the remaining segments straight into the output and
  // publish atomically via rename. A failed write leaves no output behind.
  const tmpOut = output + ".tmp";
  const writer = io.createWriter(tmpOut);
  try {
    if (current.length > 0) await mergeGroup(io, tmpDir, current, writer, false);
    await writer.close();
  } catch (err) {
    await io.remove(tmpOut);
    throw err;
  }
  await io.rename(tmpOut, output);
  return passes;
}

/**
 * Stable external merge sort of a JSONL file by its bigint "key" field.
 *
 * - Never holds more than `budget` records in memory.
 * - Throws BadLineError on the first malformed line; nothing is published.
 * - Temp segments plus a manifest in tmpDir allow `--resume` to continue
 *   run generation and merging after an interruption.
 * - The output is written to `output + ".tmp"` and renamed into place only
 *   after the full sorted stream has been flushed.
 */
export async function externalSort(options: SortOptions): Promise<SortStats> {
  const io = options.io ?? nodeIo;
  if (!Number.isInteger(options.budget) || options.budget < 2) {
    throw new Error("budget must be an integer >= 2");
  }
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  const tmpDir = path.resolve(options.tmpDir);
  const manifestPath = path.join(tmpDir, "manifest.json");

  const st = await io.stat(input);
  await io.mkdir(tmpDir);

  let manifest: Manifest | null = null;
  let resumed = false;
  if (options.resume && (await io.exists(manifestPath))) {
    const m = (await io.readJson(manifestPath)) as Manifest;
    if (
      m.version === 1 &&
      m.input === input &&
      m.size === st.size &&
      m.mtimeMs === st.mtimeMs &&
      m.budget === options.budget
    ) {
      manifest = m;
      resumed = true;
    }
  }
  if (!manifest) {
    await io.removeDir(tmpDir);
    await io.mkdir(tmpDir);
    manifest = {
      version: 1,
      input,
      size: st.size,
      mtimeMs: st.mtimeMs,
      budget: options.budget,
      nextLine: 0,
      inputDone: false,
      segments: [],
    };
    await io.writeJsonAtomic(manifestPath, manifest);
  }

  if (!manifest.inputDone) {
    await generateRuns(io, options.budget, input, tmpDir, manifest, manifestPath);
  }

  const runCount = manifest.segments.length;
  const mergePasses = await mergeRuns(io, tmpDir, manifest, manifestPath, options.budget, output);

  await io.removeDir(tmpDir);
  return {
    records: manifest.nextLine,
    segments: runCount,
    mergePasses,
    resumed,
  };
}
