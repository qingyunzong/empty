import {
  accumulatorAdd,
  accumulatorRemove,
  accumulatorValue,
  createAccumulator,
  type AggregateAccumulator,
  type AggregateSpec,
} from "./aggregates.ts";
import { canonicalize, normalizeKey, structurallyEqual } from "./canonical.ts";

export type Row = Record<string, any>;
export type RowKey = string | number;

export interface DataSource<TRow = any> {
  readonly kind: "table" | "view";
  readonly name: string;
  readonly size: number;
  get(key: RowKey): TRow | undefined;
  has(key: RowKey): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<TRow>;
  entries(): IterableIterator<[string, TRow]>;
  toArray(): TRow[];
  /** @internal */
  _entryMap(): Map<string, TRow>;
  [Symbol.iterator](): IterableIterator<TRow>;
}

export interface TableOptions<TRow extends object> {
  key?: keyof TRow | ((row: TRow) => RowKey);
  primaryKey?: keyof TRow | ((row: TRow) => RowKey);
  generateKey?: (row: TRow) => RowKey;
}

export interface ViewChange<TRow = any> {
  readonly type: "insert" | "update" | "delete";
  readonly beforeKey?: string;
  readonly afterKey?: string;
  readonly before?: TRow;
  readonly after?: TRow;
}

export type Delta<TRow = any> = ViewChange<TRow>;

export interface MaintenanceStats {
  viewUpdates: number;
  insertedRows: number;
  updatedRows: number;
  deletedRows: number;
  affectedInputRows: number;
  tuplesExamined: number;
  groupsUpdated: number;
  aggregateAdds: number;
  aggregateRemoves: number;
  recomputes: number;
}

export interface ViewDefinition<TOut = any> {
  name?: string;
  from: DataSource | readonly DataSource[] | Record<string, DataSource>;
  where?: (...args: any[]) => boolean;
  on?: (...args: any[]) => boolean;
  select: (...args: any[]) => TOut;
  key?: (...args: any[]) => RowKey;
  keyBy?: (...args: any[]) => RowKey;
  groupBy?: (...args: any[]) => unknown;
  group?: (...args: any[]) => unknown;
  aggregates?: Record<string, AggregateSpec>;
  aggregate?: Record<string, AggregateSpec>;
  having?: (groupKey: unknown, values: Record<string, unknown>) => boolean;
}

export type SourceRef<TRow extends object = Row> = Table<TRow> | string;

export type TableChange<TRow extends object = Row> =
  | {
      readonly type: "insert";
      readonly table: SourceRef<TRow>;
      readonly row: TRow;
    }
  | {
      readonly type: "update";
      readonly table: SourceRef<TRow>;
      readonly key: RowKey;
      readonly patch?: Partial<TRow> | ((draft: TRow) => TRow | void);
      readonly row?: TRow;
    }
  | {
      readonly type: "delete";
      readonly table: SourceRef<TRow>;
      readonly key: RowKey;
    };

type InputShape = "single" | "array" | "record";

interface InputBinding {
  readonly sources: readonly DataSource[];
  readonly shape: InputShape;
  readonly names: readonly string[];
  invoke<T>(fn: (...args: any[]) => T, rows: any[]): T;
}

function isDataSource(value: unknown): value is DataSource {
  return Boolean(
    value &&
      typeof value === "object" &&
      ((value as DataSource).kind === "table" || (value as DataSource).kind === "view") &&
      typeof (value as DataSource).entries === "function",
  );
}

function normalizeFrom(from: ViewDefinition["from"]): InputBinding {
  if (isDataSource(from)) {
    return {
      sources: [from],
      shape: "single",
      names: [from.name],
      invoke: (fn, rows) => fn(rows[0]),
    };
  }

  if (Array.isArray(from)) {
    if (from.length === 0) throw new Error("a view requires at least one input");
    if (!from.every(isDataSource)) throw new Error("all view inputs must be tables or views");
    return {
      sources: from,
      shape: "array",
      names: from.map((source) => source.name),
      invoke: (fn, rows) => fn(...rows),
    };
  }

  if (from && typeof from === "object") {
    const entries = Object.entries(from as Record<string, DataSource>);
    if (entries.length === 0) throw new Error("a view requires at least one input");
    if (!entries.every(([, source]) => isDataSource(source))) {
      throw new Error("all view inputs must be tables or views");
    }
    return {
      sources: entries.map(([, source]) => source),
      shape: "record",
      names: entries.map(([name]) => name),
      invoke: (fn, rows) => {
        const context: Record<string, any> = {};
        entries.forEach(([name], index) => {
          context[name] = rows[index];
        });
        return fn(context);
      },
    };
  }

  throw new Error("invalid view input specification");
}

function emptyStats(): MaintenanceStats {
  return {
    viewUpdates: 0,
    insertedRows: 0,
    updatedRows: 0,
    deletedRows: 0,
    affectedInputRows: 0,
    tuplesExamined: 0,
    groupsUpdated: 0,
    aggregateAdds: 0,
    aggregateRemoves: 0,
    recomputes: 0,
  };
}

function addStats(target: MaintenanceStats, source: MaintenanceStats): void {
  target.viewUpdates += source.viewUpdates;
  target.insertedRows += source.insertedRows;
  target.updatedRows += source.updatedRows;
  target.deletedRows += source.deletedRows;
  target.affectedInputRows += source.affectedInputRows;
  target.tuplesExamined += source.tuplesExamined;
  target.groupsUpdated += source.groupsUpdated;
  target.aggregateAdds += source.aggregateAdds;
  target.aggregateRemoves += source.aggregateRemoves;
  target.recomputes += source.recomputes;
}

interface TableJournalEntry {
  readonly table: Table<any>;
  readonly key: string;
  readonly had: boolean;
  readonly previous?: any;
}

interface Tuple {
  readonly rows: any[];
  readonly keys: string[];
  readonly signature: string;
}

interface GroupState {
  readonly groupKey: unknown;
  readonly canonical: string;
  contributionCount: number;
  readonly accumulators: Record<string, AggregateAccumulator>;
  outputKey?: string;
}

interface RenderGroup {
  visible: boolean;
  key?: string;
  row?: any;
  values: Record<string, unknown>;
}

export class Table<TRow extends object = Row> implements DataSource<TRow> {
  readonly kind = "table" as const;
  readonly name: string;
  readonly #rows = new Map<string, TRow>();
  readonly #keyOf: (row: TRow) => string;
  readonly #generateKey: (row: TRow) => RowKey;
  readonly #database: Database;
  readonly #autoKeys = new WeakMap<object, string>();
  readonly #hasKeyOption: boolean;
  #autoKey = 0;

  constructor(name: string, database: Database, options: TableOptions<TRow> = {}) {
    if (!name) throw new Error("table name must not be empty");
    this.name = name;
    this.#database = database;
    const keyOption = options.key ?? options.primaryKey;
    this.#hasKeyOption = keyOption !== undefined;

    if (typeof keyOption === "function") {
      this.#keyOf = (row) => normalizeKey(keyOption(row));
    } else if (keyOption !== undefined) {
      const property = keyOption;
      this.#keyOf = (row) => {
        const value = (row as Record<PropertyKey, unknown>)[property as PropertyKey];
        if (value === undefined || value === null) {
          throw new Error(`row is missing primary key field ${String(property)}`);
        }
        return normalizeKey(value);
      };
    } else {
      this.#keyOf = (row) => {
        const record = row as Record<string, unknown>;
        if (record.id !== undefined && record.id !== null) return normalizeKey(record.id);
        const generated = this.#autoKeys.get(row);
        if (generated !== undefined) return generated;
        throw new Error("table has no key option and the row has no id");
      };
    }

    this.#generateKey = options.generateKey
      ? (row) => normalizeKey(options.generateKey!(row))
      : (row) => {
          const record = row as Record<string, unknown>;
          if (record.id !== undefined && record.id !== null) return normalizeKey(record.id);
          let key: string;
          do {
            key = `auto:${++this.#autoKey}`;
          } while (this.#rows.has(key));
          return key;
        };
  }

  get size(): number {
    return this.#rows.size;
  }

  get(key: RowKey): TRow | undefined {
    return this.#rows.get(normalizeKey(key));
  }

  has(key: RowKey): boolean {
    return this.#rows.has(normalizeKey(key));
  }

  keys(): IterableIterator<string> {
    return this.#rows.keys();
  }

  values(): IterableIterator<TRow> {
    return this.#rows.values();
  }

  entries(): IterableIterator<[string, TRow]> {
    return this.#rows.entries();
  }

  toArray(): TRow[] {
    return [...this.#rows.values()];
  }

  rows(): TRow[] {
    return this.toArray();
  }

  all(): TRow[] {
    return this.toArray();
  }

  [Symbol.iterator](): IterableIterator<TRow> {
    return this.values();
  }

  /** @internal */
  _entryMap(): Map<string, TRow> {
    return this.#rows;
  }

  insert(row: TRow): string {
    return this.#database._runTableMutation(() => {
      const key = this.#newRowKey(row);
      if (this.#rows.has(key)) throw new Error(`duplicate key ${key} in table ${this.name}`);
      this.#database._setTableRow(this, key, row);
      this.#database._propagate(this, [
        { type: "insert", afterKey: key, after: row },
      ]);
      return key;
    });
  }

  insertMany(rows: readonly TRow[]): string[] {
    if (rows.length === 0) return [];
    return this.#database.transaction(() => rows.map((row) => this.insert(row))) as string[];
  }

  upsert(row: TRow): string {
    return this.#database._runTableMutation(() => {
      const key = this.#newRowKey(row);
      const previous = this.#rows.get(key);
      this.#database._setTableRow(this, key, row);
      this.#database._propagate(this, [
        previous === undefined
          ? { type: "insert", afterKey: key, after: row }
          : { type: "update", beforeKey: key, afterKey: key, before: previous, after: row },
      ]);
      return key;
    });
  }

  put(row: TRow): string {
    return this.upsert(row);
  }

  update(
    key: RowKey,
    patch: Partial<TRow> | ((draft: TRow) => TRow | void),
  ): string {
    return this.#database._runTableMutation(() => {
      const previousKey = normalizeKey(key);
      const previous = this.#rows.get(previousKey);
      if (previous === undefined) throw new Error(`row ${previousKey} not found in table ${this.name}`);

      let next: TRow;
      if (typeof patch === "function") {
        const draft = { ...previous } as TRow;
        const returned = patch(draft);
        next = (returned === undefined ? draft : returned) as TRow;
      } else {
        next = { ...previous, ...patch };
      }

      let nextKey: string;
      try {
        nextKey = this.#keyOf(next);
      } catch (error) {
        if (this.#hasKeyOption) throw error;
        nextKey = previousKey;
        this.#autoKeys.set(next, nextKey);
      }
      if (nextKey !== previousKey && this.#rows.has(nextKey)) {
        throw new Error(`duplicate key ${nextKey} in table ${this.name}`);
      }

      this.#database._removeTableRow(this, previousKey);
      this.#database._setTableRow(this, nextKey, next);
      this.#database._propagate(this, [
        {
          type: "update",
          beforeKey: previousKey,
          afterKey: nextKey,
          before: previous,
          after: next,
        },
      ]);
      return nextKey;
    });
  }

  replace(key: RowKey, row: TRow): string {
    return this.update(key, () => row);
  }

  delete(key: RowKey): boolean {
    return this.#database._runTableMutation(() => {
      const normalized = normalizeKey(key);
      const previous = this.#rows.get(normalized);
      if (previous === undefined) return false;
      this.#database._removeTableRow(this, normalized);
      this.#database._propagate(this, [
        { type: "delete", beforeKey: normalized, before: previous },
      ]);
      return true;
    });
  }

  remove(key: RowKey): boolean {
    return this.delete(key);
  }

  clear(): void {
    this.#database.transaction(() => {
      for (const key of [...this.#rows.keys()]) this.delete(key);
    });
  }

  #newRowKey(row: TRow): string {
    if (this.#hasKeyOption) return this.#keyOf(row);
    const record = row as Record<string, unknown>;
    if (record.id !== undefined && record.id !== null) return this.#keyOf(row);
    const key = normalizeKey(this.#generateKey(row));
    this.#autoKeys.set(row, key);
    return key;
  }
}

export class View<TOut = any> implements DataSource<TOut> {
  readonly kind = "view" as const;
  readonly name: string;
  readonly definition: ViewDefinition<TOut>;
  readonly inputs: readonly DataSource[];
  readonly #database: Database;
  readonly #binding: InputBinding;
  readonly #grouped: boolean;
  readonly #stats = emptyStats();
  #rows = new Map<string, TOut>();
  #groups = new Map<string, GroupState>();
  #outputOwners = new Map<string, string>();

  constructor(name: string, database: Database, definition: ViewDefinition<TOut>) {
    if (!name) throw new Error("view name must not be empty");
    if (!definition || typeof definition.select !== "function") {
      throw new Error(`view ${name} requires a select function`);
    }
    if (definition.where === undefined && definition.on !== undefined) {
      definition = { ...definition, where: definition.on };
    }
    if (definition.key === undefined && definition.keyBy !== undefined) {
      definition = { ...definition, key: definition.keyBy };
    }
    if (definition.groupBy === undefined && definition.group !== undefined) {
      definition = { ...definition, groupBy: definition.group };
    }
    if (definition.aggregates === undefined && definition.aggregate !== undefined) {
      definition = { ...definition, aggregates: definition.aggregate };
    }
    this.name = name;
    this.#database = database;
    this.definition = definition;
    this.#binding = normalizeFrom(definition.from);
    this.inputs = this.#binding.sources;
    this.#grouped = definition.groupBy !== undefined;

    if (this.#grouped) {
      if (!definition.aggregates || Object.keys(definition.aggregates).length === 0) {
        throw new Error(`grouped view ${name} requires at least one aggregate`);
      }
    } else if (definition.aggregates) {
      throw new Error(`view ${name} has aggregates but no groupBy`);
    }
  }

  get size(): number {
    return this.#rows.size;
  }

  get grouped(): boolean {
    return this.#grouped;
  }

  get dependencies(): readonly string[] {
    return [...new Set(this.inputs.map((source) => source.name))];
  }

  get stats(): MaintenanceStats {
    return { ...this.#stats };
  }

  get(key: RowKey): TOut | undefined {
    return this.#rows.get(normalizeKey(key));
  }

  has(key: RowKey): boolean {
    return this.#rows.has(normalizeKey(key));
  }

  keys(): IterableIterator<string> {
    return this.#rows.keys();
  }

  values(): IterableIterator<TOut> {
    return this.#rows.values();
  }

  entries(): IterableIterator<[string, TOut]> {
    return this.#rows.entries();
  }

  toArray(): TOut[] {
    return [...this.#rows.values()];
  }

  rows(): TOut[] {
    return this.toArray();
  }

  all(): TOut[] {
    return this.toArray();
  }

  snapshot(): Map<string, TOut> {
    return new Map(this.#rows);
  }

  [Symbol.iterator](): IterableIterator<TOut> {
    return this.values();
  }

  /** @internal */
  _entryMap(): Map<string, TOut> {
    return this.#rows;
  }

  /** @internal */
  _inputIndexes(source: DataSource): number[] {
    const result: number[] = [];
    this.inputs.forEach((input, index) => {
      if (input === source) result.push(index);
    });
    return result;
  }

  resetStats(): void {
    Object.assign(this.#stats, emptyStats());
  }

  /**
   * Recompute this view from scratch and cascade the resulting row-level diff
   * to downstream views.
   */
  recompute(): this {
    const changes = this._recomputeInternal();
    this.#stats.recomputes++;
    if (changes.length > 0) {
      this.#database._propagateFromView(this, changes);
    }
    return this;
  }

  /**
   * Compute the view from current inputs without mutating the materialization.
   */
  compute(): Map<string, TOut> {
    return this.#buildFullState().rows;
  }

  /**
   * Throw if incremental state differs from a from-scratch evaluation.
   */
  verify(): true {
    const expected = this.compute();
    assertMapsEqual(this.name, this.#rows, expected);
    return true;
  }

  /** @internal */
  _recomputeInternal(): Delta<TOut>[] {
    const previousRows = this.#rows;
    const built = this.#buildFullState();
    this.#rows = built.rows;
    this.#groups = built.groups;
    this.#outputOwners = built.owners;
    return diffRowMaps(previousRows, this.#rows);
  }

  /** @internal */
  _applyDeltas(inputDeltas: Map<number, Delta[]>): Delta<TOut>[] {
    if (inputDeltas.size === 0) return [];

    const currentMaps = this.inputs.map((source) => source._entryMap());
    const beforeMaps = currentMaps.map((current, index) => {
      const deltas = inputDeltas.get(index);
      if (!deltas || deltas.length === 0) return current;
      const before = new Map(current);
      for (const delta of deltas) {
        if (delta.type === "insert") {
          if (delta.afterKey !== undefined) before.delete(delta.afterKey);
        } else if (delta.type === "delete") {
          if (delta.beforeKey !== undefined) before.set(delta.beforeKey, delta.before);
        } else {
          if (delta.afterKey !== undefined) before.delete(delta.afterKey);
          if (delta.beforeKey !== undefined) before.set(delta.beforeKey, delta.before);
        }
      }
      return before;
    });

    const oldChanged = this.inputs.map(() => new Map<string, any>());
    const newChanged = this.inputs.map(() => new Map<string, any>());
    for (const [index, deltas] of inputDeltas) {
      for (const delta of deltas) {
        if (delta.type !== "insert" && delta.beforeKey !== undefined) {
          oldChanged[index].set(delta.beforeKey, delta.before);
        }
        if (delta.type !== "delete" && delta.afterKey !== undefined) {
          newChanged[index].set(delta.afterKey, delta.after);
        }
      }
    }

    for (const map of oldChanged) this.#stats.affectedInputRows += map.size;
    for (const map of newChanged) this.#stats.affectedInputRows += map.size;

    const oldTuples = this.#collectAffectedTuples(oldChanged, beforeMaps);
    const newTuples = this.#collectAffectedTuples(newChanged, currentMaps);
    const removed: Tuple[] = [];
    const added: Tuple[] = [];

    for (const [signature, tuple] of oldTuples) {
      if (!newTuples.has(signature)) removed.push(tuple);
    }
    for (const [signature, tuple] of newTuples) {
      if (!oldTuples.has(signature)) added.push(tuple);
    }

    this.#stats.viewUpdates++;
    const changes = this.#grouped
      ? this.#applyGroupedChanges(removed, added)
      : this.#applyFlatChanges(removed, added);
    this.#stats.insertedRows += changes.filter((change) => change.type === "insert").length;
    this.#stats.updatedRows += changes.filter((change) => change.type === "update").length;
    this.#stats.deletedRows += changes.filter((change) => change.type === "delete").length;
    return changes;
  }

  #collectAffectedTuples(
    changedByInput: Map<string, any>[],
    stateMaps: Map<string, any>[],
  ): Map<string, Tuple> {
    const result = new Map<string, Tuple>();
    const entryArrays = stateMaps.map((map) => [...map.entries()]);
    const inputCount = this.inputs.length;

    for (let changedIndex = 0; changedIndex < inputCount; changedIndex++) {
      const changedEntries = [...changedByInput[changedIndex].entries()];
      if (changedEntries.length === 0) continue;

      for (const [changedKey, changedRow] of changedEntries) {
        const selected: [string, any][] = new Array(inputCount);
        const visit = (index: number): void => {
          if (index === inputCount) {
            this.#stats.tuplesExamined++;
            const rows = selected.map((entry) => entry[1]);
            if (this.definition.where && !this.#binding.invoke(this.definition.where, rows)) {
              return;
            }
            const keys = selected.map((entry) => entry[0]);
            const signature = selected
              .map(
                (entry, position) =>
                  `${position}:${JSON.stringify(entry[0])}:${canonicalize(entry[1])}`,
              )
              .join("|");
            result.set(signature, { rows, keys, signature });
            return;
          }

          if (index === changedIndex) {
            selected[index] = [changedKey, changedRow];
            visit(index + 1);
            return;
          }

          for (const entry of entryArrays[index]) {
            selected[index] = entry;
            visit(index + 1);
          }
        };
        visit(0);
      }
    }
    return result;
  }

  #flatKey(tuple: Tuple): string {
    if (this.definition.key) {
      return normalizeKey(this.#binding.invoke(this.definition.key, tuple.rows));
    }
    if (tuple.keys.length === 1) return tuple.keys[0];
    return canonicalize(tuple.keys);
  }

  #applyFlatChanges(removed: Tuple[], added: Tuple[]): Delta<TOut>[] {
    const removable = new Set<string>();
    for (const tuple of removed) removable.add(this.#flatKey(tuple));

    const candidates = new Map<string, TOut>();
    for (const tuple of added) {
      const key = this.#flatKey(tuple);
      const row = this.#binding.invoke(this.definition.select, tuple.rows) as TOut;
      const existing = candidates.get(key);
      if (existing !== undefined && !structurallyEqual(existing, row)) {
        throw new Error(`view ${this.name} produced duplicate key ${key}`);
      }
      candidates.set(key, row);
    }

    const changes: Delta<TOut>[] = [];
    for (const [key, row] of candidates) {
      const previous = this.#rows.get(key);
      if (previous === undefined) {
        this.#rows.set(key, row);
        changes.push({ type: "insert", afterKey: key, after: row });
      } else if (!structurallyEqual(previous, row)) {
        this.#rows.set(key, row);
        changes.push({ type: "update", beforeKey: key, afterKey: key, before: previous, after: row });
      }
    }

    for (const key of removable) {
      if (candidates.has(key)) continue;
      const previous = this.#rows.get(key);
      if (previous === undefined) continue;
      this.#rows.delete(key);
      changes.push({ type: "delete", beforeKey: key, before: previous });
    }

    return changes;
  }

  #newGroupState(groupKey: unknown, canonical: string): GroupState {
    const accumulators: Record<string, AggregateAccumulator> = {};
    for (const [name, spec] of Object.entries(this.definition.aggregates!)) {
      accumulators[name] = createAccumulator(spec);
    }
    return { groupKey, canonical, contributionCount: 0, accumulators };
  }

  #groupCanonical(tuple: Tuple): { groupKey: unknown; canonical: string } {
    const groupKey = this.#binding.invoke(this.definition.groupBy!, tuple.rows);
    return { groupKey, canonical: canonicalize(groupKey) };
  }

  #addTupleToGroup(state: GroupState, tuple: Tuple, trackStats = true): void {
    state.contributionCount++;
    for (const accumulator of Object.values(state.accumulators)) {
      accumulatorAdd(accumulator, tuple.rows, (fn, rows) => this.#binding.invoke(fn, rows));
      if (trackStats) this.#stats.aggregateAdds++;
    }
  }

  #removeTupleFromGroup(state: GroupState, tuple: Tuple): void {
    if (state.contributionCount <= 0) {
      throw new Error(`view ${this.name} tried to remove from an empty group ${state.canonical}`);
    }
    state.contributionCount--;
    for (const accumulator of Object.values(state.accumulators)) {
      accumulatorRemove(accumulator, tuple.rows, (fn, rows) => this.#binding.invoke(fn, rows));
      this.#stats.aggregateRemoves++;
    }
  }

  #applyGroupedChanges(removed: Tuple[], added: Tuple[]): Delta<TOut>[] {
    const touched = new Set<string>();

    for (const tuple of removed) {
      const { canonical } = this.#groupCanonical(tuple);
      const state = this.#groups.get(canonical);
      if (!state) throw new Error(`view ${this.name} lost group ${canonical}`);
      this.#removeTupleFromGroup(state, tuple);
      touched.add(canonical);
    }

    for (const tuple of added) {
      const { groupKey, canonical } = this.#groupCanonical(tuple);
      let state = this.#groups.get(canonical);
      if (!state) {
        state = this.#newGroupState(groupKey, canonical);
        this.#groups.set(canonical, state);
      }
      this.#addTupleToGroup(state, tuple);
      touched.add(canonical);
    }

    const changes: Delta<TOut>[] = [];
    for (const canonical of touched) this.#finalizeGroup(canonical, changes);
    return changes;
  }

  #renderGroup(state: GroupState): RenderGroup {
    const values: Record<string, unknown> = {};
    for (const [name, accumulator] of Object.entries(state.accumulators)) {
      values[name] = accumulatorValue(accumulator);
    }

    const visible = this.definition.having
      ? this.definition.having(state.groupKey, values)
      : true;
    if (!visible) return { visible: false, values };

    const key = this.definition.key
      ? normalizeKey((this.definition.key as any)(state.groupKey, values))
      : normalizeKey(state.groupKey);
    const row = (this.definition.select as any)(state.groupKey, values) as TOut;
    return { visible: true, key, row, values };
  }

  #finalizeGroup(canonical: string, changes: Delta<TOut>[]): void {
    const state = this.#groups.get(canonical);
    if (!state) return;

    const previousKey = state.outputKey;
    const previous = previousKey === undefined ? undefined : this.#rows.get(previousKey);

    if (state.contributionCount === 0) {
      if (previousKey !== undefined && previous !== undefined) {
        this.#rows.delete(previousKey);
        this.#outputOwners.delete(previousKey);
        changes.push({ type: "delete", beforeKey: previousKey, before: previous });
      }
      this.#groups.delete(canonical);
      state.outputKey = undefined;
      return;
    }

    const rendered = this.#renderGroup(state);
    this.#stats.groupsUpdated++;
    if (!rendered.visible || rendered.key === undefined) {
      if (previousKey !== undefined && previous !== undefined) {
        this.#rows.delete(previousKey);
        this.#outputOwners.delete(previousKey);
        changes.push({ type: "delete", beforeKey: previousKey, before: previous });
      }
      state.outputKey = undefined;
      return;
    }

    const owner = this.#outputOwners.get(rendered.key);
    if (owner !== undefined && owner !== canonical) {
      throw new Error(`view ${this.name} produced duplicate key ${rendered.key}`);
    }

    if (previousKey !== undefined && previousKey !== rendered.key && previous !== undefined) {
      this.#rows.delete(previousKey);
      this.#outputOwners.delete(previousKey);
      changes.push({ type: "delete", beforeKey: previousKey, before: previous });
    }

    state.outputKey = rendered.key;
    this.#outputOwners.set(rendered.key, canonical);

    if (previous === undefined || previousKey !== rendered.key) {
      this.#rows.set(rendered.key, rendered.row as TOut);
      changes.push({ type: "insert", afterKey: rendered.key, after: rendered.row });
    } else if (!structurallyEqual(previous, rendered.row)) {
      this.#rows.set(rendered.key, rendered.row as TOut);
      changes.push({
        type: "update",
        beforeKey: rendered.key,
        afterKey: rendered.key,
        before: previous,
        after: rendered.row,
      });
    }
  }

  #buildFullState(): {
    rows: Map<string, TOut>;
    groups: Map<string, GroupState>;
    owners: Map<string, string>;
  } {
    const rows = new Map<string, TOut>();
    const groups = new Map<string, GroupState>();
    const owners = new Map<string, string>();

    if (this.#grouped) {
      for (const tuple of this.#enumerateAllTuples()) {
        const { groupKey, canonical } = this.#groupCanonical(tuple);
        let state = groups.get(canonical);
        if (!state) {
          state = this.#newGroupState(groupKey, canonical);
          groups.set(canonical, state);
        }
        this.#addTupleToGroup(state, tuple, false);
      }

      for (const [canonical, state] of groups) {
        if (state.contributionCount === 0) {
          groups.delete(canonical);
          continue;
        }
        const rendered = this.#renderGroup(state);
        if (!rendered.visible || rendered.key === undefined) continue;
        const owner = owners.get(rendered.key);
        if (owner !== undefined && owner !== canonical) {
          throw new Error(`view ${this.name} produced duplicate key ${rendered.key}`);
        }
        owners.set(rendered.key, canonical);
        rows.set(rendered.key, rendered.row as TOut);
        state.outputKey = rendered.key;
      }
    } else {
      for (const tuple of this.#enumerateAllTuples()) {
        const key = this.#flatKey(tuple);
        const row = this.#binding.invoke(this.definition.select, tuple.rows) as TOut;
        if (rows.has(key)) throw new Error(`view ${this.name} produced duplicate key ${key}`);
        rows.set(key, row);
      }
    }

    return { rows, groups, owners };
  }

  *#enumerateAllTuples(): Generator<Tuple> {
    const entryArrays = this.inputs.map((source) => [...source._entryMap().entries()]);
    const inputCount = entryArrays.length;
    const selected: [string, any][] = new Array(inputCount);
    const view = this;

    function* visit(index: number): Generator<Tuple> {
      if (index === inputCount) {
        const keys = selected.map((entry) => entry[0]);
        const rows = selected.map((entry) => entry[1]);
        if (view.definition.where && !view.#binding.invoke(view.definition.where, rows)) return;
        yield {
          rows,
          keys,
          signature: selected
            .map(
              (entry, position) =>
                `${position}:${JSON.stringify(entry[0])}:${canonicalize(entry[1])}`,
            )
            .join("|"),
        };
        return;
      }

      for (const entry of entryArrays[index]) {
        selected[index] = entry;
        yield* visit(index + 1);
      }
    }

    yield* visit(0);
  }
}

export class Transaction {
  readonly #database: Database;
  readonly #start: number;
  #active = true;

  constructor(database: Database, start: number) {
    this.#database = database;
    this.#start = start;
  }

  get active(): boolean {
    return this.#active;
  }

  insert<TRow extends object>(table: Table<TRow>, row: TRow): string {
    this.#assertActive();
    return table.insert(row);
  }

  update<TRow extends object>(
    table: Table<TRow>,
    key: RowKey,
    patch: Partial<TRow> | ((draft: TRow) => TRow | void),
  ): string {
    this.#assertActive();
    return table.update(key, patch);
  }

  delete<TRow extends object>(table: Table<TRow>, key: RowKey): boolean {
    this.#assertActive();
    return table.delete(key);
  }

  commit(): void {
    this.#assertActive();
    this.#active = false;
    this.#database._endTransaction();
  }

  rollback(): void {
    this.#assertActive();
    this.#database._rollbackTo(this.#start);
    this.#active = false;
    this.#database._endTransaction();
  }

  #assertActive(): void {
    if (!this.#active) throw new Error("transaction is no longer active");
  }
}

export interface ViewChangeEvent {
  readonly type: "view";
  readonly view: string;
  readonly changes: readonly Delta[];
  readonly revision: number;
}

export type ChangeListener = (event: ViewChangeEvent) => void;

export class Database {
  readonly #tables = new Map<string, Table<any>>();
  readonly #views = new Map<string, View<any>>();
  readonly #viewOrder: View<any>[] = [];
  readonly #journal: TableJournalEntry[] = [];
  readonly #listeners = new Set<ChangeListener>();
  readonly #stats = emptyStats();
  #topoCache?: View<any>[];
  #revision = 0;
  #transactionDepth = 0;

  get revision(): number {
    return this.#revision;
  }

  get tables(): readonly Table<any>[] {
    return [...this.#tables.values()];
  }

  get views(): readonly View<any>[] {
    return this.#viewOrder.slice();
  }

  get stats(): MaintenanceStats {
    const total = emptyStats();
    addStats(total, this.#stats);
    for (const view of this.#viewOrder) addStats(total, view.stats);
    return total;
  }

  table<TRow extends object = Row>(name: string, options: TableOptions<TRow> = {}): Table<TRow> {
    this.#assertNameAvailable(name);
    const table = new Table<TRow>(name, this, options);
    this.#tables.set(name, table);
    return table;
  }

  view<TOut = any>(name: string, definition: ViewDefinition<TOut>): View<TOut>;
  view<TOut = any>(definition: ViewDefinition<TOut> & { name: string }): View<TOut>;
  view<TOut = any>(
    nameOrDefinition: string | (ViewDefinition<TOut> & { name: string }),
    maybeDefinition?: ViewDefinition<TOut>,
  ): View<TOut> {
    const name =
      typeof nameOrDefinition === "string" ? nameOrDefinition : nameOrDefinition.name;
    const definition =
      typeof nameOrDefinition === "string" ? maybeDefinition : nameOrDefinition;
    if (!definition) throw new Error("view definition is required");
    this.#assertNameAvailable(name);
    const view = new View<TOut>(name, this, definition);

    for (const source of view.inputs) {
      if (!this.#isRegistered(source)) {
        throw new Error(`view ${name} references unregistered source ${source.name}`);
      }
    }

    this.#views.set(name, view);
    this.#viewOrder.push(view);
    this.#topoCache = undefined;
    return view;
  }

  getTable(name: string): Table<any> | undefined {
    return this.#tables.get(name);
  }

  getView(name: string): View<any> | undefined {
    return this.#views.get(name);
  }

  get(name: string): DataSource | undefined {
    return this.#tables.get(name) ?? this.#views.get(name);
  }

  has(name: string): boolean {
    return this.#tables.has(name) || this.#views.has(name);
  }

  topologicalOrder(): string[] {
    return this.#topoViews().map((view) => view.name);
  }

  begin(): Transaction {
    this.#transactionDepth++;
    return new Transaction(this, this.#journal.length);
  }

  transaction<T>(callback: (transaction: Transaction) => T | Promise<T>): T | Promise<T> {
    const transaction = this.begin();
    let result: T | Promise<T>;
    try {
      result = callback(transaction);
    } catch (error) {
      if (transaction.active) transaction.rollback();
      throw error;
    }

    if (result && typeof (result as Promise<T>).then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          if (transaction.active) transaction.commit();
          return value;
        },
        (error) => {
          if (transaction.active) transaction.rollback();
          throw error;
        },
      );
    }

    if (transaction.active) transaction.commit();
    return result;
  }

  run<T>(callback: (transaction: Transaction) => T | Promise<T>): T | Promise<T> {
    return this.transaction(callback);
  }

  apply(change: TableChange<any>): string | boolean {
    return this.#applyChange(this.#resolveTable(change.table), change);
  }

  applyChanges(changes: readonly TableChange<any>[]): (string | boolean)[] {
    return this.transaction(() => {
      const results: (string | boolean)[] = [];
      for (const change of changes) {
        results.push(this.#applyChange(this.#resolveTable(change.table), change));
      }
      return results;
    }) as (string | boolean)[];
  }

  applyBatch(changes: readonly TableChange<any>[]): (string | boolean)[] {
    return this.applyChanges(changes);
  }

  recomputeAll(): void {
    for (const view of this.#topoViews()) {
      view._recomputeInternal();
      this.#stats.recomputes += 1;
    }
    this.#revision++;
  }

  verifyAll(): true {
    for (const view of this.#topoViews()) view.verify();
    return true;
  }

  assertConsistent(): true {
    return this.verifyAll();
  }

  verify(): true {
    return this.verifyAll();
  }

  createTable<TRow extends object = Row>(
    name: string,
    options: TableOptions<TRow> = {},
  ): Table<TRow> {
    return this.table(name, options);
  }

  createView<TOut = any>(name: string, definition: ViewDefinition<TOut>): View<TOut> {
    return this.view(name, definition);
  }

  defineTable<TRow extends object = Row>(
    name: string,
    options: TableOptions<TRow> = {},
  ): Table<TRow> {
    return this.table(name, options);
  }

  defineView<TOut = any>(name: string, definition: ViewDefinition<TOut>): View<TOut> {
    return this.view(name, definition);
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  resetStats(): void {
    Object.assign(this.#stats, emptyStats());
    for (const view of this.#viewOrder) view.resetStats();
  }

  /** @internal */
  _setTableRow<TRow extends object>(table: Table<TRow>, key: string, row: TRow): void {
    const rows = table._entryMap();
    if (!rows.has(key)) {
      this.#journal.push({ table, key, had: false });
    } else {
      this.#journal.push({ table, key, had: true, previous: rows.get(key) });
    }
    rows.set(key, row);
  }

  /** @internal */
  _removeTableRow<TRow extends object>(table: Table<TRow>, key: string): void {
    const rows = table._entryMap();
    if (!rows.has(key)) return;
    this.#journal.push({ table, key, had: true, previous: rows.get(key) });
    rows.delete(key);
  }

  /** @internal */
  _runTableMutation<T>(mutation: () => T): T {
    const topLevel = this.#transactionDepth === 0;
    if (topLevel) this.#journal.length = 0;
    const checkpoint = this.#journal.length;
    try {
      const result = mutation();
      if (topLevel) this.#journal.length = 0;
      return result;
    } catch (error) {
      if (this.#journal.length > checkpoint) this._rollbackTo(checkpoint);
      if (topLevel) this.#journal.length = 0;
      throw error;
    }
  }

  /** @internal */
  _rollbackTo(checkpoint: number): void {
    if (this.#journal.length <= checkpoint) return;
    while (this.#journal.length > checkpoint) {
      const entry = this.#journal.pop()!;
      const rows = entry.table._entryMap();
      if (entry.had) rows.set(entry.key, entry.previous);
      else rows.delete(entry.key);
    }
    this.recomputeAll();
  }

  /** @internal */
  _endTransaction(): void {
    if (this.#transactionDepth > 0) this.#transactionDepth--;
    if (this.#transactionDepth === 0) this.#journal.length = 0;
  }

  /** @internal */
  _propagate(origin: DataSource, deltas: Delta[]): void {
    if (deltas.length === 0) return;
    this.#revision++;
    this.#propagateDirty(origin, deltas);
  }

  /** @internal */
  _propagateFromView(origin: View<any>, deltas: Delta[]): void {
    if (deltas.length === 0) return;
    this.#revision++;
    this._notifyView(origin, deltas);
    this.#propagateDirty(origin, deltas);
  }

  #propagateDirty(origin: DataSource, deltas: Delta[]): void {
    const dirty = new Map<View<any>, Map<number, Delta[]>>();
    const markDependents = (source: DataSource, changes: Delta[]): void => {
      for (const view of this.#topoViews()) {
        const indexes = view._inputIndexes(source);
        if (indexes.length === 0) continue;
        let byInput = dirty.get(view);
        if (!byInput) {
          byInput = new Map();
          dirty.set(view, byInput);
        }
        for (const index of indexes) {
          const existing = byInput.get(index);
          if (existing) existing.push(...changes);
          else byInput.set(index, changes.slice());
        }
      }
    };

    markDependents(origin, deltas);
    for (const view of this.#topoViews()) {
      const inputDeltas = dirty.get(view);
      if (!inputDeltas) continue;
      const changes = view._applyDeltas(inputDeltas);
      if (changes.length === 0) continue;
      this._notifyView(view, changes);
      markDependents(view, changes);
    }
  }

  /** @internal */
  _notifyView(view: View<any>, changes: Delta[]): void {
    if (this.#listeners.size === 0) return;
    const event: ViewChangeEvent = {
      type: "view",
      view: view.name,
      changes: changes.slice(),
      revision: this.#revision,
    };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A diagnostic listener must not be able to corrupt materialized state.
      }
    }
  }

  #topoViews(): View<any>[] {
    if (this.#topoCache) return this.#topoCache;
    const indegree = new Map<View<any>, number>();
    const outgoing = new Map<View<any>, Set<View<any>>>();
    const indexByView = new Map<View<any>, number>();
    this.#viewOrder.forEach((view, index) => indexByView.set(view, index));

    for (const view of this.#viewOrder) {
      indegree.set(view, 0);
      outgoing.set(view, new Set());
    }

    for (const view of this.#viewOrder) {
      const seen = new Set<View<any>>();
      for (const source of view.inputs) {
        if (source.kind !== "view") continue;
        const upstream = source as View<any>;
        if (seen.has(upstream)) continue;
        seen.add(upstream);
        if (!indegree.has(upstream)) {
          throw new Error(`view ${view.name} depends on an unregistered view ${upstream.name}`);
        }
        outgoing.get(upstream)!.add(view);
        indegree.set(view, indegree.get(view)! + 1);
      }
    }

    const ready = [...this.#viewOrder]
      .filter((view) => indegree.get(view) === 0)
      .sort((left, right) => indexByView.get(left)! - indexByView.get(right)!);
    const order: View<any>[] = [];

    while (ready.length > 0) {
      const view = ready.shift()!;
      order.push(view);
      const next = [...outgoing.get(view)!].sort(
        (left, right) => indexByView.get(left)! - indexByView.get(right)!,
      );
      for (const dependent of next) {
        const remaining = indegree.get(dependent)! - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) {
          ready.push(dependent);
          ready.sort((left, right) => indexByView.get(left)! - indexByView.get(right)!);
        }
      }
    }

    if (order.length !== this.#viewOrder.length) throw new Error("view dependency cycle detected");
    this.#topoCache = order;
    return order;
  }

  #isRegistered(source: DataSource): boolean {
    return this.#tables.get(source.name) === source || this.#views.get(source.name) === source;
  }

  #assertNameAvailable(name: string): void {
    if (!name) throw new Error("name must not be empty");
    if (this.#tables.has(name) || this.#views.has(name)) {
      throw new Error(`data source ${name} already exists`);
    }
  }

  #resolveTable<TRow extends object>(reference: SourceRef<TRow>): Table<TRow> {
    if (typeof reference === "string") {
      const table = this.#tables.get(reference);
      if (!table) throw new Error(`table ${reference} does not exist`);
      return table as Table<TRow>;
    }
    if (reference.kind !== "table" || this.#tables.get(reference.name) !== reference) {
      throw new Error(`table ${reference.name} is not registered in this database`);
    }
    return reference;
  }

  #applyChange<TRow extends object>(
    table: Table<TRow>,
    change: TableChange<TRow>,
  ): string | boolean {
    if (change.type === "insert") return table.insert(change.row);
    if (change.type === "delete") return table.delete(change.key);
    if (change.row !== undefined) return table.replace(change.key, change.row);
    if (change.patch === undefined) throw new Error("update change requires row or patch");
    return table.update(change.key, change.patch);
  }
}

function diffRowMaps<T>(
  previous: Map<string, T>,
  next: Map<string, T>,
): Delta<T>[] {
  const changes: Delta<T>[] = [];
  for (const [key, row] of next) {
    const before = previous.get(key);
    if (before === undefined) {
      changes.push({ type: "insert", afterKey: key, after: row });
    } else if (!structurallyEqual(before, row)) {
      changes.push({ type: "update", beforeKey: key, afterKey: key, before, after: row });
    }
  }
  for (const [key, row] of previous) {
    if (!next.has(key)) changes.push({ type: "delete", beforeKey: key, before: row });
  }
  return changes;
}

function assertMapsEqual<T>(
  viewName: string,
  actual: Map<string, T>,
  expected: Map<string, T>,
): void {
  for (const [key, row] of expected) {
    if (!actual.has(key)) throw new Error(`view ${viewName} is missing row ${key}`);
    if (!structurallyEqual(actual.get(key), row)) {
      throw new Error(`view ${viewName} has a stale row at key ${key}`);
    }
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) throw new Error(`view ${viewName} has an extra row ${key}`);
  }
}

export function createDatabase(): Database {
  return new Database();
}

export const IncrementalViewDatabase = Database;
export const ViewMaintainer = Database;
