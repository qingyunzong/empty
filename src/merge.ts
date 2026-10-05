export type TransformFn = (value: unknown) => unknown;

export interface TransformStep {
  name: string;
  apply: TransformFn;
}

export interface Contribution {
  source: string;
  version: number;
  chain: string[];
  raw: unknown;
}

export interface ValueGroup {
  value: unknown;
  contributions: Contribution[];
}

export type FieldStatus = "resolved" | "conflict";

export interface FieldView {
  field: string;
  status: FieldStatus;
  value?: unknown;
  values: ValueGroup[];
  sources: Contribution[];
}

export type Snapshot =
  | { status: "absent" }
  | { status: "resolved"; value: unknown }
  | { status: "conflict"; values: unknown[] };

export interface FieldChange {
  field: string;
  from: Snapshot;
  to: Snapshot;
}

export type NetDiff = FieldChange[];

export interface SourceInfo {
  source: string;
  version: number;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  return canonicalize(a) === canonicalize(b);
}

export function snapshotOf(view: FieldView | undefined): Snapshot {
  if (view === undefined) return { status: "absent" };
  if (view.status === "resolved") return { status: "resolved", value: view.value };
  return { status: "conflict", values: view.values.map((g) => g.value) };
}

export function diffSnapshots(
  before: ReadonlyMap<string, Snapshot>,
  after: ReadonlyMap<string, Snapshot>,
): NetDiff {
  const diff: NetDiff = [];
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const absent: Snapshot = { status: "absent" };
  for (const field of [...keys].sort()) {
    const from = before.get(field) ?? absent;
    const to = after.get(field) ?? absent;
    if (!snapshotsEqual(from, to)) diff.push({ field, from, to });
  }
  return diff;
}

interface FieldState {
  groups: Map<string, { value: unknown; contributions: Contribution[] }>;
}

export class MergeStore {
  private readonly fields = new Map<string, FieldState>();
  private readonly sourceVersions = new Map<string, number>();

  apply(
    source: string,
    version: number,
    record: Record<string, unknown>,
    chain: TransformStep[] = [],
  ): NetDiff {
    const before = this.snapshotAll();
    this.removeSource(source);
    this.sourceVersions.set(source, version);
    const chainNames = chain.map((step) => step.name);
    for (const [field, raw] of Object.entries(record)) {
      const value = chain.reduce<unknown>((v, step) => step.apply(v), raw);
      this.addContribution(field, { source, version, chain: chainNames, raw }, value);
    }
    return diffSnapshots(before, this.snapshotAll());
  }

  retract(source: string): NetDiff {
    const before = this.snapshotAll();
    this.removeSource(source);
    this.sourceVersions.delete(source);
    return diffSnapshots(before, this.snapshotAll());
  }

  get(field: string): FieldView | undefined {
    const state = this.fields.get(field);
    if (state === undefined) return undefined;
    return this.buildView(field, state);
  }

  view(): Record<string, FieldView> {
    const out: Record<string, FieldView> = {};
    for (const [field, state] of this.fields) {
      out[field] = this.buildView(field, state);
    }
    return out;
  }

  sources(): SourceInfo[] {
    return [...this.sourceVersions.entries()]
      .map(([source, version]) => ({ source, version }))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  }

  private addContribution(field: string, contribution: Contribution, value: unknown): void {
    let state = this.fields.get(field);
    if (state === undefined) {
      state = { groups: new Map() };
      this.fields.set(field, state);
    }
    const key = canonicalize(value);
    const group = state.groups.get(key);
    if (group === undefined) {
      state.groups.set(key, { value, contributions: [contribution] });
    } else {
      group.contributions.push(contribution);
    }
  }

  private removeSource(source: string): void {
    for (const [field, state] of this.fields) {
      for (const [key, group] of state.groups) {
        const kept = group.contributions.filter((c) => c.source !== source);
        if (kept.length === 0) state.groups.delete(key);
        else group.contributions = kept;
      }
      if (state.groups.size === 0) this.fields.delete(field);
    }
  }

  private buildView(field: string, state: FieldState): FieldView {
    const values: ValueGroup[] = [...state.groups.values()]
      .map((g) => ({
        value: g.value,
        contributions: g.contributions
          .map((c) => ({ ...c, chain: [...c.chain] }))
          .sort(
            (a, b) =>
              compareStrings(a.source, b.source) || a.version - b.version,
          ),
      }))
      .sort((a, b) => compareStrings(canonicalize(a.value), canonicalize(b.value)));
    const sources = values
      .flatMap((g) => g.contributions)
      .sort((a, b) => compareStrings(a.source, b.source) || a.version - b.version);
    if (values.length === 1) {
      const only = values[0] as ValueGroup;
      return { field, status: "resolved", value: only.value, values, sources };
    }
    return { field, status: "conflict", values, sources };
  }

  private snapshotAll(): Map<string, Snapshot> {
    const out = new Map<string, Snapshot>();
    for (const [field, state] of this.fields) {
      out.set(field, snapshotOf(this.buildView(field, state)));
    }
    return out;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
