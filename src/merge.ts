import { applyChain, type Scalar } from "./transforms.js";

export type RecordData = { [field: string]: Scalar };

export interface SourceInput {
  id: string;
  version: number;
  record: RecordData;
}

export interface Provenance {
  sourceId: string;
  sourceVersion: number;
  raw: Scalar;
  transforms: string[];
  value: Scalar;
}

export interface Candidate {
  value: Scalar;
  sources: Provenance[];
}

export interface FieldView {
  status: "value" | "conflict";
  value: Scalar | undefined;
  candidates: Candidate[];
  sources: Provenance[];
}

export interface FieldChange {
  field: string;
  before: FieldView | null;
  after: FieldView | null;
}

export interface MergeDiff {
  changes: FieldChange[];
}

export interface MergeOptions {
  fieldTransforms?: { [field: string]: string[] };
  defaultTransforms?: string[];
}

function valueKey(value: Scalar): string {
  return `${typeof value}:${String(value)}`;
}

function computeView(provs: Map<string, Provenance>): FieldView {
  const groups = new Map<string, Candidate>();
  for (const prov of provs.values()) {
    const key = valueKey(prov.value);
    let candidate = groups.get(key);
    if (!candidate) {
      candidate = { value: prov.value, sources: [] };
      groups.set(key, candidate);
    }
    candidate.sources.push(prov);
  }
  const candidates = [...groups.values()].sort((a, b) =>
    valueKey(a.value) < valueKey(b.value) ? -1 : 1,
  );
  for (const candidate of candidates) {
    candidate.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  }
  const sources = candidates
    .flatMap((c) => c.sources)
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (candidates.length === 1) {
    return { status: "value", value: candidates[0]!.value, candidates, sources };
  }
  return { status: "conflict", value: undefined, candidates, sources };
}

function viewEquals(a: FieldView | null, b: FieldView | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class MergeStore {
  private readonly fields = new Map<string, Map<string, Provenance>>();
  private readonly sources = new Map<string, SourceInput>();

  constructor(private readonly options: MergeOptions = {}) {}

  sourceIds(): string[] {
    return [...this.sources.keys()].sort();
  }

  hasSource(id: string): boolean {
    return this.sources.has(id);
  }

  private chainFor(field: string): string[] {
    const { fieldTransforms = {}, defaultTransforms = [] } = this.options;
    return fieldTransforms[field] ?? defaultTransforms;
  }

  private viewOf(field: string): FieldView | null {
    const provs = this.fields.get(field);
    if (!provs || provs.size === 0) {
      return null;
    }
    return computeView(provs);
  }

  addSource(input: SourceInput): MergeDiff {
    const changes: FieldChange[] = [];
    if (this.sources.has(input.id)) {
      const replaced = this.withdrawSource(input.id);
      changes.push(...replaced.changes);
    }
    this.sources.set(input.id, input);
    for (const field of Object.keys(input.record).sort()) {
      const before = this.viewOf(field);
      const chain = this.chainFor(field);
      const raw = input.record[field]!;
      const prov: Provenance = {
        sourceId: input.id,
        sourceVersion: input.version,
        raw,
        transforms: [...chain],
        value: applyChain(raw, chain),
      };
      let provs = this.fields.get(field);
      if (!provs) {
        provs = new Map();
        this.fields.set(field, provs);
      }
      provs.set(input.id, prov);
      const after = this.viewOf(field);
      this.pushChange(changes, field, before, after);
    }
    return { changes: MergeStore.coalesce(changes) };
  }

  withdrawSource(id: string): MergeDiff {
    const input = this.sources.get(id);
    if (!input) {
      return { changes: [] };
    }
    this.sources.delete(id);
    const changes: FieldChange[] = [];
    for (const field of Object.keys(input.record).sort()) {
      const before = this.viewOf(field);
      const provs = this.fields.get(field);
      if (provs) {
        provs.delete(id);
        if (provs.size === 0) {
          this.fields.delete(field);
        }
      }
      const after = this.viewOf(field);
      this.pushChange(changes, field, before, after);
    }
    return { changes };
  }

  private pushChange(
    changes: FieldChange[],
    field: string,
    before: FieldView | null,
    after: FieldView | null,
  ): void {
    if (!viewEquals(before, after)) {
      changes.push({ field, before, after });
    }
  }

  private static coalesce(changes: FieldChange[]): FieldChange[] {
    const byField = new Map<string, FieldChange>();
    for (const change of changes) {
      const existing = byField.get(change.field);
      if (existing) {
        existing.after = change.after;
      } else {
        byField.set(change.field, { ...change });
      }
    }
    return [...byField.values()].filter((c) => !viewEquals(c.before, c.after));
  }

  getField(field: string): FieldView | null {
    return this.viewOf(field);
  }

  snapshot(): { [field: string]: FieldView } {
    const out: { [field: string]: FieldView } = {};
    for (const field of [...this.fields.keys()].sort()) {
      out[field] = this.viewOf(field)!;
    }
    return out;
  }

  static rebuild(sources: SourceInput[], options: MergeOptions = {}): MergeStore {
    const store = new MergeStore(options);
    for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
      store.addSource(source);
    }
    return store;
  }
}
