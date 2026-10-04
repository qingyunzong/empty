import {
  diffResults,
  groupCounts,
  groupSums,
  sameEntries,
  topK,
} from "./evaluate.js";
import type {
  BatchOp,
  Delta,
  QuerySpec,
  ResultEntry,
  Row,
} from "./types.js";

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileError";
  }
}

interface Snapshot {
  generation: number;
  result: ResultEntry[];
}

function freezeResult(result: ResultEntry[]): ResultEntry[] {
  for (const entry of result) Object.freeze(entry);
  return Object.freeze(result) as ResultEntry[];
}

export class Subscription {
  #engine: LiveQuery | null;
  readonly version: number;
  readonly generation: number;

  constructor(engine: LiveQuery, version: number, generation: number) {
    this.#engine = engine;
    this.version = version;
    this.generation = generation;
  }

  read(): ResultEntry[] {
    if (this.#engine === null) throw new Error("subscription released");
    return this.#engine.readAt(this.version);
  }

  release(): void {
    if (this.#engine === null) return;
    this.#engine.releaseVersion(this.version);
    this.#engine = null;
  }
}

export interface LiveQueryOptions {
  verifyEachBatch?: boolean;
}

export class LiveQuery {
  #rows = new Map<string, Row>();
  #spec: QuerySpec;
  #sums = new Map<string, number>();
  #counts = new Map<string, number>();
  #result: ResultEntry[] = [];
  #version = 0;
  #generation = 1;
  #snapshots = new Map<number, Snapshot>();
  #pins = new Map<number, number>();
  #listeners = new Set<(delta: Delta) => void>();
  #verifyEachBatch: boolean;
  #reconcileChecks = 0;

  constructor(spec: QuerySpec, options: LiveQueryOptions = {}) {
    this.#spec = spec;
    this.#verifyEachBatch = options.verifyEachBatch ?? true;
    this.#commit();
  }

  get version(): number {
    return this.#version;
  }

  get generation(): number {
    return this.#generation;
  }

  get reconcileChecks(): number {
    return this.#reconcileChecks;
  }

  get retainedVersions(): number[] {
    return [...this.#snapshots.keys()].sort((a, b) => a - b);
  }

  read(): ResultEntry[] {
    return this.#result;
  }

  readAt(version: number): ResultEntry[] {
    const snapshot = this.#snapshots.get(version);
    if (!snapshot) {
      throw new Error(`version ${version} is not retained`);
    }
    return snapshot.result;
  }

  generationAt(version: number): number {
    const snapshot = this.#snapshots.get(version);
    if (!snapshot) {
      throw new Error(`version ${version} is not retained`);
    }
    return snapshot.generation;
  }

  pin(version: number = this.#version): Subscription {
    const snapshot = this.#snapshots.get(version);
    if (!snapshot) {
      throw new Error(`version ${version} is not retained`);
    }
    this.#pins.set(version, (this.#pins.get(version) ?? 0) + 1);
    return new Subscription(this, version, snapshot.generation);
  }

  releaseVersion(version: number): void {
    const count = this.#pins.get(version);
    if (count === undefined) return;
    if (count <= 1) this.#pins.delete(version);
    else this.#pins.set(version, count - 1);
    this.#gc();
  }

  onDelta(listener: (delta: Delta) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  applyBatch(ops: BatchOp[]): Delta {
    for (const op of ops) {
      if (op.type === "upsert") this.#upsert(op.row);
      else this.#delete(op.id);
    }
    const delta = this.#commit();
    if (this.#verifyEachBatch) this.reconcile();
    return delta;
  }

  setQuery(spec: QuerySpec): Delta {
    this.#spec = spec;
    this.#generation += 1;
    this.#sums = groupSums(this.#rows.values(), spec);
    this.#counts = groupCounts(this.#rows.values(), spec);
    const delta = this.#commit();
    if (this.#verifyEachBatch) this.reconcile();
    return delta;
  }

  reconcile(): void {
    const expectedSums = groupSums(this.#rows.values(), this.#spec);
    if (expectedSums.size !== this.#sums.size) {
      throw new ReconcileError(
        `group count mismatch: incremental=${this.#sums.size} full-scan=${expectedSums.size}`,
      );
    }
    for (const [key, sum] of expectedSums) {
      if (this.#sums.get(key) !== sum) {
        throw new ReconcileError(
          `sum mismatch for key ${key}: incremental=${this.#sums.get(key)} full-scan=${sum}`,
        );
      }
    }
    const expectedResult = topK(expectedSums, this.#spec.k);
    if (!sameEntries(expectedResult, this.#result)) {
      throw new ReconcileError(
        `top-k mismatch at version ${this.#version}: ` +
          `incremental=${JSON.stringify(this.#result)} ` +
          `full-scan=${JSON.stringify(expectedResult)}`,
      );
    }
    this.#reconcileChecks += 1;
  }

  #upsert(row: Row): void {
    const prev = this.#rows.get(row.id);
    if (prev !== undefined && this.#spec.filter(prev)) {
      this.#adjust(prev.key, -prev.value, -1);
    }
    this.#rows.set(row.id, row);
    if (this.#spec.filter(row)) {
      this.#adjust(row.key, row.value, 1);
    }
  }

  #delete(id: string): void {
    const prev = this.#rows.get(id);
    if (prev === undefined) return;
    if (this.#spec.filter(prev)) {
      this.#adjust(prev.key, -prev.value, -1);
    }
    this.#rows.delete(id);
  }

  #adjust(key: string, sumDelta: number, countDelta: number): void {
    const sum = (this.#sums.get(key) ?? 0) + sumDelta;
    const count = (this.#counts.get(key) ?? 0) + countDelta;
    if (count === 0) {
      this.#sums.delete(key);
      this.#counts.delete(key);
    } else {
      this.#sums.set(key, sum);
      this.#counts.set(key, count);
    }
  }

  #commit(): Delta {
    const next = topK(this.#sums, this.#spec.k);
    const changes = diffResults(this.#result, next);
    this.#result = next;
    this.#version += 1;
    const delta: Delta = {
      version: this.#version,
      generation: this.#generation,
      changes,
    };
    this.#snapshots.set(this.#version, {
      generation: this.#generation,
      result: freezeResult([...next]),
    });
    this.#gc();
    for (const listener of this.#listeners) listener(delta);
    return delta;
  }

  #gc(): void {
    for (const version of this.#snapshots.keys()) {
      if (version === this.#version) continue;
      if (this.#pins.has(version)) continue;
      this.#snapshots.delete(version);
    }
  }
}
