import * as fs from "node:fs";
import * as path from "node:path";
import { computeGroupAnalysis, groupKeyOf, pairKeyOf } from "./analysis.js";
import type { GroupAnalysis, PairRecord, Sample, Snapshot, VerifyReport } from "./types.js";

export class ValidationError extends Error {}
export class DuplicateSampleIdError extends Error {}
export class DuplicateRoundConflictError extends Error {}
export class UnknownSampleError extends Error {}

const SNAPSHOT_PATTERN = /^snapshot-(\d+)\.json$/;

function validateSample(sample: Sample): void {
  if (typeof sample.id !== "string" || sample.id.length === 0) {
    throw new ValidationError("sample id must be a non-empty string");
  }
  if (typeof sample.env !== "string" || sample.env.length === 0) {
    throw new ValidationError("env must be a non-empty string");
  }
  if (typeof sample.inputDigest !== "string" || sample.inputDigest.length === 0) {
    throw new ValidationError("inputDigest must be a non-empty string");
  }
  if (!Number.isInteger(sample.round) || sample.round < 0) {
    throw new ValidationError("round must be a non-negative integer");
  }
  if (sample.arm !== "A" && sample.arm !== "B") {
    throw new ValidationError("arm must be 'A' or 'B'");
  }
  if (!Number.isInteger(sample.durationMs)) {
    throw new ValidationError("durationMs must be an integer");
  }
}

interface StoreState {
  samples: Map<string, Sample>;
  pairs: Map<string, PairRecord>;
  analyses: Map<string, GroupAnalysis>;
}

export class BenchmarkStore {
  private version = 0;
  private state: StoreState = { samples: new Map(), pairs: new Map(), analyses: new Map() };

  private constructor(private readonly dir: string) {}

  static open(dir: string): BenchmarkStore {
    fs.mkdirSync(dir, { recursive: true });
    const store = new BenchmarkStore(dir);
    const latest = store.latestSnapshotFile();
    if (latest !== null) {
      const snapshot = JSON.parse(fs.readFileSync(latest, "utf8")) as Snapshot;
      store.version = snapshot.version;
      const samples = new Map<string, Sample>();
      for (const sample of snapshot.samples) samples.set(sample.id, sample);
      const pairs = buildPairs(samples.values());
      const analyses = new Map<string, GroupAnalysis>();
      for (const analysis of snapshot.analyses) {
        analyses.set(groupKeyOf(analysis.env, analysis.inputDigest), analysis);
      }
      store.state = { samples, pairs, analyses };
    }
    return store;
  }

  get currentVersion(): number {
    return this.version;
  }

  submit(sample: Sample): Snapshot {
    validateSample(sample);
    if (this.state.samples.has(sample.id)) {
      throw new DuplicateSampleIdError(`sample id already exists: ${sample.id}`);
    }
    const pairKey = pairKeyOf(sample.env, sample.inputDigest, sample.round);
    const existing = this.state.pairs.get(pairKey);
    if (existing !== undefined) {
      const occupant = sample.arm === "A" ? existing.a : existing.b;
      if (occupant !== null) {
        throw new DuplicateRoundConflictError(
          `round conflict at ${pairKey} arm ${sample.arm}: held by sample ${occupant}`,
        );
      }
    }

    const next = this.cloneState();
    next.samples.set(sample.id, sample);
    next.pairs.set(pairKey, {
      env: sample.env,
      inputDigest: sample.inputDigest,
      round: sample.round,
      a: sample.arm === "A" ? sample.id : existing?.a ?? null,
      b: sample.arm === "B" ? sample.id : existing?.b ?? null,
    });
    this.refreshGroup(next, sample.env, sample.inputDigest);
    return this.commit(next);
  }

  withdraw(sampleId: string): Snapshot {
    const sample = this.state.samples.get(sampleId);
    if (sample === undefined) {
      throw new UnknownSampleError(`unknown sample id: ${sampleId}`);
    }
    const next = this.cloneState();
    next.samples.delete(sampleId);
    const pairKey = pairKeyOf(sample.env, sample.inputDigest, sample.round);
    const pair = next.pairs.get(pairKey)!;
    const updated: PairRecord = {
      ...pair,
      a: pair.a === sampleId ? null : pair.a,
      b: pair.b === sampleId ? null : pair.b,
    };
    if (updated.a === null && updated.b === null) {
      next.pairs.delete(pairKey);
    } else {
      next.pairs.set(pairKey, updated);
    }
    this.refreshGroup(next, sample.env, sample.inputDigest);
    return this.commit(next);
  }

  analyze(): ReadonlyArray<GroupAnalysis> {
    return [...this.state.analyses.values()].sort((a, b) =>
      groupKeyOf(a.env, a.inputDigest).localeCompare(groupKeyOf(b.env, b.inputDigest)),
    );
  }

  getSample(id: string): Sample | undefined {
    return this.state.samples.get(id);
  }

  verify(): VerifyReport {
    const groups = new Map<string, PairRecord[]>();
    for (const pair of this.state.pairs.values()) {
      const key = groupKeyOf(pair.env, pair.inputDigest);
      const list = groups.get(key) ?? [];
      list.push(pair);
      groups.set(key, list);
    }

    const corrected: string[] = [];
    const next = this.cloneState();
    for (const [key, pairs] of groups) {
      const first = pairs[0];
      const fresh = computeGroupAnalysis(first.env, first.inputDigest, pairs, next.samples);
      const maintained = next.analyses.get(key);
      if (maintained === undefined || JSON.stringify(maintained) !== JSON.stringify(fresh)) {
        next.analyses.set(key, fresh);
        corrected.push(key);
      }
    }
    for (const key of [...next.analyses.keys()]) {
      if (!groups.has(key)) {
        next.analyses.delete(key);
        corrected.push(key);
      }
    }

    if (corrected.length === 0) {
      return { checkedGroups: groups.size, correctedGroups: [], snapshotVersion: null };
    }
    const snapshot = this.commit(next);
    return { checkedGroups: groups.size, correctedGroups: corrected.sort(), snapshotVersion: snapshot.version };
  }

  listSnapshots(): number[] {
    return this.snapshotFiles().map((f) => f.version);
  }

  snapshot(version: number): Snapshot | null {
    const file = path.join(this.dir, `snapshot-${String(version).padStart(6, "0")}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  }

  private cloneState(): StoreState {
    return {
      samples: new Map(this.state.samples),
      pairs: new Map(this.state.pairs),
      analyses: new Map(this.state.analyses),
    };
  }

  private refreshGroup(state: StoreState, env: string, inputDigest: string): void {
    const key = groupKeyOf(env, inputDigest);
    const pairs = [...state.pairs.values()].filter(
      (p) => p.env === env && p.inputDigest === inputDigest,
    );
    if (pairs.length === 0) {
      state.analyses.delete(key);
      return;
    }
    state.analyses.set(key, computeGroupAnalysis(env, inputDigest, pairs, state.samples));
  }

  private commit(next: StoreState): Snapshot {
    const snapshot: Snapshot = {
      version: this.version + 1,
      createdAt: new Date().toISOString(),
      samples: [...next.samples.values()].sort((a, b) => a.id.localeCompare(b.id)),
      analyses: [...next.analyses.values()].sort((a, b) =>
        groupKeyOf(a.env, a.inputDigest).localeCompare(groupKeyOf(b.env, b.inputDigest)),
      ),
    };
    const file = path.join(this.dir, `snapshot-${String(snapshot.version).padStart(6, "0")}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, file);
    this.state = next;
    this.version = snapshot.version;
    return snapshot;
  }

  private snapshotFiles(): Array<{ version: number; file: string }> {
    return fs
      .readdirSync(this.dir)
      .map((name) => {
        const match = SNAPSHOT_PATTERN.exec(name);
        return match === null ? null : { version: Number(match[1]), file: path.join(this.dir, name) };
      })
      .filter((entry): entry is { version: number; file: string } => entry !== null)
      .sort((a, b) => a.version - b.version);
  }

  private latestSnapshotFile(): string | null {
    const files = this.snapshotFiles();
    return files.length === 0 ? null : files[files.length - 1].file;
  }
}

function buildPairs(samples: Iterable<Sample>): Map<string, PairRecord> {
  const pairs = new Map<string, PairRecord>();
  for (const sample of samples) {
    const key = pairKeyOf(sample.env, sample.inputDigest, sample.round);
    const existing = pairs.get(key) ?? {
      env: sample.env,
      inputDigest: sample.inputDigest,
      round: sample.round,
      a: null as string | null,
      b: null as string | null,
    };
    pairs.set(key, {
      ...existing,
      a: sample.arm === "A" ? sample.id : existing.a,
      b: sample.arm === "B" ? sample.id : existing.b,
    });
  }
  return pairs;
}
