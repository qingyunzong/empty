import {
  Condition,
  QuerySpec,
  Row,
  canonicalSpec,
  generationOf,
  matchAll,
} from './conditions.js';

export interface BatchOp {
  /** Row id. Upsert when `row` is present, delete when omitted. */
  id: string;
  row?: Row;
}

export interface ResultEntry {
  key: string;
  sum: number;
  rank: number;
}

export interface DeltaEntry {
  key: string;
  change: 'added' | 'removed' | 'updated';
  oldSum?: number;
  newSum?: number;
  oldRank?: number;
  newRank?: number;
}

export interface Publication {
  generation: string;
  /** Monotonic per generation; starts at 1 for the initial publication. */
  version: number;
  /** Net difference between the previous and the new top-k result. */
  delta: DeltaEntry[];
  /** Full new top-k result. */
  result: ResultEntry[];
}

interface GroupState {
  sum: number;
  count: number;
}

interface ViewState {
  spec: QuerySpec;
  canonical: string;
  groups: Map<string, GroupState>;
  published: ResultEntry[];
  version: number;
  snapshots: Map<number, ResultEntry[]>;
}

interface Subscriber {
  generation: string;
  pinnedVersion: number;
}

/** Deterministic order: sum descending, ties broken by key ascending. */
export function compareEntries(a: ResultEntry, b: ResultEntry): number {
  if (a.sum !== b.sum) return b.sum - a.sum;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function topKOf(groups: Map<string, GroupState>, k: number): ResultEntry[] {
  const entries: ResultEntry[] = [];
  for (const [key, g] of groups) {
    entries.push({ key, sum: g.sum, rank: 0 });
  }
  entries.sort(compareEntries);
  const sliced = entries.slice(0, Math.max(0, k));
  sliced.forEach((e, i) => {
    e.rank = i + 1;
  });
  return sliced;
}

function contribution(spec: QuerySpec, row: Row): { key: string; value: number } | null {
  if (!matchAll(row, spec.where)) return null;
  const rawKey = row[spec.groupBy];
  if (rawKey === undefined) return null;
  const rawVal = row[spec.sum];
  const value = typeof rawVal === 'number' ? rawVal : Number(rawVal ?? 0);
  if (Number.isNaN(value)) {
    throw new Error(`non-numeric sum column "${spec.sum}": ${String(rawVal)}`);
  }
  return { key: String(rawKey), value };
}

function applyContribution(
  groups: Map<string, GroupState>,
  key: string,
  value: number,
  countDelta: number,
): void {
  const g = groups.get(key);
  if (!g) {
    groups.set(key, { sum: value, count: countDelta });
    return;
  }
  g.sum += value;
  g.count += countDelta;
  if (g.count === 0) groups.delete(key);
}

/** Net diff between two top-k results; keys with identical sum are omitted. */
export function diffResults(oldR: ResultEntry[], newR: ResultEntry[]): DeltaEntry[] {
  const oldByKey = new Map(oldR.map((e) => [e.key, e]));
  const newByKey = new Map(newR.map((e) => [e.key, e]));
  const delta: DeltaEntry[] = [];
  for (const n of newR) {
    const o = oldByKey.get(n.key);
    if (!o) {
      delta.push({ key: n.key, change: 'added', newSum: n.sum, newRank: n.rank });
    } else if (o.sum !== n.sum) {
      delta.push({
        key: n.key,
        change: 'updated',
        oldSum: o.sum,
        newSum: n.sum,
        oldRank: o.rank,
        newRank: n.rank,
      });
    }
  }
  for (const o of oldR) {
    if (!newByKey.has(o.key)) {
      delta.push({ key: o.key, change: 'removed', oldSum: o.sum, oldRank: o.rank });
    }
  }
  delta.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return delta;
}

export class TableQueryEngine {
  private rows = new Map<string, Row>();
  private views = new Map<string, ViewState>();
  private subscribers = new Map<number, Subscriber>();
  private nextToken = 1;

  /**
   * Register a continuous query. Identical specs share a generation;
   * any change to conditions or parameters yields a new generation.
   * Publishes version 1 computed by full scan.
   */
  registerQuery(spec: QuerySpec): { generation: string; publication: Publication } {
    if (!Number.isInteger(spec.topK) || spec.topK < 0) {
      throw new Error(`topK must be a non-negative integer, got ${spec.topK}`);
    }
    const generation = generationOf(spec);
    const existing = this.views.get(generation);
    if (existing) {
      return {
        generation,
        publication: {
          generation,
          version: existing.version,
          delta: [],
          result: cloneEntries(existing.published),
        },
      };
    }
    const groups = new Map<string, GroupState>();
    for (const row of this.rows.values()) {
      const c = contribution(spec, row);
      if (c) applyContribution(groups, c.key, c.value, 1);
    }
    const result = topKOf(groups, spec.topK);
    const view: ViewState = {
      spec,
      canonical: canonicalSpec(spec),
      groups,
      published: result,
      version: 1,
      snapshots: new Map([[1, cloneEntries(result)]]),
    };
    this.views.set(generation, view);
    return {
      generation,
      publication: {
        generation,
        version: 1,
        delta: diffResults([], result),
        result: cloneEntries(result),
      },
    };
  }

  /**
   * Apply a batch of upserts/deletes atomically, then publish exactly one
   * net-diff publication per registered generation. Every batch is checked
   * against a full scan; a mismatch throws and indicates an engine bug.
   */
  applyBatch(ops: BatchOp[]): Publication[] {
    // Capture originals before mutating so repeated ops on one id collapse
    // to their net effect (batch-start row vs batch-end row).
    const originals = new Map<string, Row | undefined>();
    for (const op of ops) {
      if (!originals.has(op.id)) originals.set(op.id, this.rows.get(op.id));
      if (op.row === undefined) {
        this.rows.delete(op.id);
      } else {
        this.rows.set(op.id, op.row);
      }
    }
    const touched: { oldRow?: Row; newRow?: Row }[] = [];
    for (const [id, oldRow] of originals) {
      const newRow = this.rows.get(id);
      if (oldRow === newRow) continue;
      const t: { oldRow?: Row; newRow?: Row } = {};
      if (oldRow !== undefined) t.oldRow = oldRow;
      if (newRow !== undefined) t.newRow = newRow;
      touched.push(t);
    }

    const publications: Publication[] = [];
    for (const [generation, view] of this.views) {
      for (const t of touched) {
        if (t.oldRow !== undefined) {
          const c = contribution(view.spec, t.oldRow);
          if (c) applyContribution(view.groups, c.key, -c.value, -1);
        }
        if (t.newRow !== undefined) {
          const c = contribution(view.spec, t.newRow);
          if (c) applyContribution(view.groups, c.key, c.value, 1);
        }
      }
      const result = topKOf(view.groups, view.spec.topK);
      const delta = diffResults(view.published, result);
      view.published = result;
      view.version += 1;
      view.snapshots.set(view.version, cloneEntries(result));
      publications.push({
        generation,
        version: view.version,
        delta,
        result: cloneEntries(result),
      });
    }

    this.verifyAgainstFullScan();
    return publications;
  }

  /** Recompute every generation from the raw rows and compare with incremental state. */
  verifyAgainstFullScan(): void {
    for (const [generation, view] of this.views) {
      const expected = new Map<string, GroupState>();
      for (const row of this.rows.values()) {
        const c = contribution(view.spec, row);
        if (c) applyContribution(expected, c.key, c.value, 1);
      }
      if (expected.size !== view.groups.size) {
        throw new Error(
          `full-scan mismatch in generation ${generation}: ` +
            `group count ${view.groups.size} != ${expected.size}`,
        );
      }
      for (const [key, g] of view.groups) {
        const e = expected.get(key);
        if (!e || e.sum !== g.sum || e.count !== g.count) {
          throw new Error(
            `full-scan mismatch in generation ${generation}, key ${key}: ` +
              `incremental ${JSON.stringify(g)} vs scanned ${JSON.stringify(e ?? null)}`,
          );
        }
      }
      const expectedTop = topKOf(expected, view.spec.topK);
      if (JSON.stringify(expectedTop) !== JSON.stringify(view.published)) {
        throw new Error(`full-scan mismatch in generation ${generation}: top-k differs`);
      }
    }
  }

  /** Read the result at a specific version, or the latest when omitted. */
  read(generation: string, version?: number): ResultEntry[] {
    const view = this.mustView(generation);
    const v = version ?? view.version;
    const snap = view.snapshots.get(v);
    if (!snap) throw new Error(`version ${v} not retained for generation ${generation}`);
    return cloneEntries(snap);
  }

  /** Subscribe: pins the current version of a generation. */
  subscribe(generation: string): number {
    const view = this.mustView(generation);
    const token = this.nextToken++;
    this.subscribers.set(token, { generation, pinnedVersion: view.version });
    return token;
  }

  /** Read exactly the version the subscriber pinned, regardless of later batches. */
  readSubscriber(token: number): { generation: string; version: number; result: ResultEntry[] } {
    const sub = this.subscribers.get(token);
    if (!sub) throw new Error(`unknown subscriber token ${token}`);
    return {
      generation: sub.generation,
      version: sub.pinnedVersion,
      result: this.read(sub.generation, sub.pinnedVersion),
    };
  }

  unsubscribe(token: number): void {
    this.subscribers.delete(token);
  }

  currentVersion(generation: string): number {
    return this.mustView(generation).version;
  }

  private mustView(generation: string): ViewState {
    const view = this.views.get(generation);
    if (!view) throw new Error(`unknown generation ${generation}`);
    return view;
  }
}

function cloneEntries(entries: ResultEntry[]): ResultEntry[] {
  return entries.map((e) => ({ ...e }));
}

export type { Condition, QuerySpec, Row };
