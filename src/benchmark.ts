import {
  averageRanks,
  averageRanksByCounting,
  exactMedian,
  wilcoxonSignedRankExact,
  type Ranker,
} from './stats.js';

export type Side = 'A' | 'B';

export interface Sample {
  id: string;
  env: string;
  input: string;
  round: number;
  side: Side;
  durationMs: number;
}

export class InvalidSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSampleError';
  }
}

export class DuplicateSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateSampleError';
  }
}

export class DuplicateRoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateRoundError';
  }
}

export class UnknownSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownSampleError';
  }
}

export interface PairedRound {
  round: number;
  aId: string;
  bId: string;
  aMs: number;
  bMs: number;
  diff: number;
}

export interface UnpairedSample {
  round: number;
  side: Side;
  sampleId: string;
  durationMs: number;
}

export interface RankedPairEvidence {
  round: number;
  aId: string;
  bId: string;
  diff: number;
  absDiff: number;
  rank: number;
  sign: 1 | -1;
}

export interface WilcoxonEvidence {
  n: number;
  droppedZeroDiffRounds: number[];
  entries: RankedPairEvidence[];
  tPlus: number;
  tMinus: number;
  statistic: number;
  permutations: number;
  extremeCount: number;
  pValue: number;
}

export interface GroupAnalysis {
  env: string;
  input: string;
  pairs: PairedRound[];
  unpaired: UnpairedSample[];
  medianDiff: number | null;
  wilcoxon: WilcoxonEvidence | null;
}

function groupKeyOf(env: string, input: string): string {
  return JSON.stringify([env, input]);
}

export function analyzeSamples(
  samples: readonly Sample[],
  ranker: Ranker = averageRanks,
): GroupAnalysis[] {
  const groups = new Map<
    string,
    { env: string; input: string; rounds: Map<number, { A?: Sample; B?: Sample }> }
  >();
  for (const sample of samples) {
    const key = groupKeyOf(sample.env, sample.input);
    let group = groups.get(key);
    if (!group) {
      group = { env: sample.env, input: sample.input, rounds: new Map() };
      groups.set(key, group);
    }
    const slot = group.rounds.get(sample.round) ?? {};
    slot[sample.side] = sample;
    group.rounds.set(sample.round, slot);
  }

  const analyses: GroupAnalysis[] = [];
  for (const group of groups.values()) {
    const rounds = [...group.rounds.keys()].sort((a, b) => a - b);
    const pairs: PairedRound[] = [];
    const unpaired: UnpairedSample[] = [];
    for (const round of rounds) {
      const slot = group.rounds.get(round)!;
      if (slot.A && slot.B) {
        pairs.push({
          round,
          aId: slot.A.id,
          bId: slot.B.id,
          aMs: slot.A.durationMs,
          bMs: slot.B.durationMs,
          diff: slot.A.durationMs - slot.B.durationMs,
        });
      } else if (slot.A) {
        unpaired.push({ round, side: 'A', sampleId: slot.A.id, durationMs: slot.A.durationMs });
      } else if (slot.B) {
        unpaired.push({ round, side: 'B', sampleId: slot.B.id, durationMs: slot.B.durationMs });
      }
    }

    const diffs = pairs.map((p) => p.diff);
    const medianDiff = exactMedian(diffs);
    const nonzeroPairs = pairs.filter((p) => p.diff !== 0);
    let wilcoxon: WilcoxonEvidence | null = null;
    if (nonzeroPairs.length > 0) {
      const outcome = wilcoxonSignedRankExact(nonzeroPairs.map((p) => p.diff), ranker)!;
      const entries: RankedPairEvidence[] = nonzeroPairs.map((p, i) => ({
        round: p.round,
        aId: p.aId,
        bId: p.bId,
        diff: p.diff,
        absDiff: Math.abs(p.diff),
        rank: outcome.ranks[i],
        sign: p.diff > 0 ? 1 : -1,
      }));
      wilcoxon = {
        n: outcome.n,
        droppedZeroDiffRounds: pairs.filter((p) => p.diff === 0).map((p) => p.round),
        entries,
        tPlus: outcome.tPlus,
        tMinus: outcome.tMinus,
        statistic: outcome.statistic,
        permutations: outcome.permutations,
        extremeCount: outcome.extremeCount,
        pValue: outcome.pValue,
      };
    }
    analyses.push({ env: group.env, input: group.input, pairs, unpaired, medianDiff, wilcoxon });
  }
  analyses.sort((a, b) =>
    a.env === b.env ? (a.input < b.input ? -1 : a.input > b.input ? 1 : 0) : a.env < b.env ? -1 : 1,
  );
  return analyses;
}

export type SnapshotKind = 'submit' | 'withdraw' | 'audit-correction';

export interface Snapshot {
  seq: number;
  kind: SnapshotKind;
  createdAt: string;
  sampleCount: number;
  groups: GroupAnalysis[];
}

export interface RankCorrection {
  env: string;
  input: string;
  reason: string;
  beforeRanks: number[] | null;
  afterRanks: number[] | null;
}

export interface AuditReport {
  checkedGroups: number;
  corrections: RankCorrection[];
  correctedSnapshot: Snapshot | null;
}

function roundKeyOf(sample: Sample): string {
  return JSON.stringify([sample.env, sample.input, sample.round, sample.side]);
}

function validateSample(sample: Sample): Sample {
  if (typeof sample.id !== 'string' || sample.id.length === 0) {
    throw new InvalidSampleError('sample id must be a non-empty string');
  }
  if (typeof sample.env !== 'string' || sample.env.length === 0) {
    throw new InvalidSampleError('env must be a non-empty string');
  }
  if (typeof sample.input !== 'string' || sample.input.length === 0) {
    throw new InvalidSampleError('input must be a non-empty string');
  }
  if (sample.side !== 'A' && sample.side !== 'B') {
    throw new InvalidSampleError(`side must be 'A' or 'B', got ${String(sample.side)}`);
  }
  if (!Number.isInteger(sample.round) || sample.round < 0) {
    throw new InvalidSampleError(`round must be a non-negative integer, got ${String(sample.round)}`);
  }
  if (!Number.isInteger(sample.durationMs) || sample.durationMs < 0) {
    throw new InvalidSampleError(
      `durationMs must be a non-negative integer, got ${String(sample.durationMs)}`,
    );
  }
  return { ...sample };
}

function wilcoxonRanksOf(group: GroupAnalysis): number[] | null {
  return group.wilcoxon ? group.wilcoxon.entries.map((e) => e.rank) : null;
}

function sameRanks(a: GroupAnalysis, b: GroupAnalysis): boolean {
  const ra = wilcoxonRanksOf(a);
  const rb = wilcoxonRanksOf(b);
  if (ra === null || rb === null) return ra === rb;
  if (ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return false;
  }
  return a.wilcoxon!.statistic === b.wilcoxon!.statistic
    && a.wilcoxon!.pValue === b.wilcoxon!.pValue;
}

export class BenchmarkStore {
  private samples = new Map<string, Sample>();
  private roundIndex = new Map<string, string>();
  private history: Snapshot[] = [];
  private seq = 0;

  submit(sample: Sample): Snapshot {
    const normalized = validateSample(sample);
    if (this.samples.has(normalized.id)) {
      throw new DuplicateSampleError(`sample id already submitted: ${normalized.id}`);
    }
    const key = roundKeyOf(normalized);
    const holder = this.roundIndex.get(key);
    if (holder !== undefined) {
      throw new DuplicateRoundError(
        `round conflict: sample ${holder} already covers env=${normalized.env} input=${normalized.input} round=${normalized.round} side=${normalized.side}`,
      );
    }
    this.samples.set(normalized.id, normalized);
    this.roundIndex.set(key, normalized.id);
    return this.record('submit');
  }

  withdraw(sampleId: string): Snapshot {
    const sample = this.samples.get(sampleId);
    if (!sample) {
      throw new UnknownSampleError(`no such sample: ${sampleId}`);
    }
    this.samples.delete(sampleId);
    this.roundIndex.delete(roundKeyOf(sample));
    return this.record('withdraw');
  }

  has(sampleId: string): boolean {
    return this.samples.has(sampleId);
  }

  get size(): number {
    return this.samples.size;
  }

  private record(kind: SnapshotKind, groups?: GroupAnalysis[]): Snapshot {
    const snapshot: Snapshot = {
      seq: (this.seq += 1),
      kind,
      createdAt: new Date().toISOString(),
      sampleCount: this.samples.size,
      groups: groups ?? analyzeSamples([...this.samples.values()]),
    };
    this.history.push(snapshot);
    return structuredClone(snapshot);
  }

  latest(): Snapshot | undefined {
    const snapshot = this.history[this.history.length - 1];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  snapshots(): Snapshot[] {
    return this.history.map((s) => structuredClone(s));
  }

  getSnapshot(seq: number): Snapshot | undefined {
    const snapshot = this.history.find((s) => s.seq === seq);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  auditRanks(): AuditReport {
    const latestSnapshot = this.history[this.history.length - 1];
    if (!latestSnapshot) {
      return { checkedGroups: 0, corrections: [], correctedSnapshot: null };
    }
    const recomputed = analyzeSamples([...this.samples.values()], averageRanksByCounting);
    const freshByGroup = new Map(recomputed.map((g) => [groupKeyOf(g.env, g.input), g]));
    const corrections: RankCorrection[] = [];
    for (const stored of latestSnapshot.groups) {
      const fresh = freshByGroup.get(groupKeyOf(stored.env, stored.input));
      if (!fresh) {
        corrections.push({
          env: stored.env,
          input: stored.input,
          reason: 'group missing after independent re-ranking',
          beforeRanks: wilcoxonRanksOf(stored),
          afterRanks: null,
        });
        continue;
      }
      if (!sameRanks(stored, fresh)) {
        corrections.push({
          env: stored.env,
          input: stored.input,
          reason: 'whole-group ranks changed under independent re-ranking',
          beforeRanks: wilcoxonRanksOf(stored),
          afterRanks: wilcoxonRanksOf(fresh),
        });
      }
    }
    const correctedSnapshot =
      corrections.length > 0 ? this.record('audit-correction', recomputed) : null;
    return {
      checkedGroups: latestSnapshot.groups.length,
      corrections,
      correctedSnapshot,
    };
  }
}
