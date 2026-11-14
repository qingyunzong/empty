import {
  DuplicateBusinessKeyError,
  RowNotFoundError,
} from "./errors.ts";
import {
  assertBusinessKey,
  keyToken,
  readBusinessKey,
  resolveKeySelector,
} from "./keys.ts";
import {
  normalizeSnapshot,
  resolveNormalizeContext,
  type NormalizeContext,
} from "./snapshot.ts";
import type {
  BusinessKey,
  KeySelector,
  NormalizedSnapshot,
  ObserveOptions,
  RowContext,
  RowPredicate,
  SelectionStoreOptions,
  SelectionStoreSnapshot,
  SnapshotRowState,
  TablePageInput,
} from "./types.ts";

export type SelectionListener<Row> = (
  snapshot: SelectionStoreSnapshot<Row>,
) => void;

export interface SelectionStoreJson {
  version: 1;
  keyField: string;
  selectedKeys: BusinessKey[];
}

/**
 * A page-independent selection model. The authoritative identity is the
 * business key, so server-side pagination, sorting, filtering and virtualized
 * rows can reorder or unload rows without losing the target set.
 */
export class TableSelectionStore<
  Row extends object = Record<string, unknown>,
> {
  readonly keyField: string;

  #keySelector: KeySelector<Row>;
  #normalizeContext: NormalizeContext<Row>;
  #predicate: RowPredicate<Row> | undefined;
  #selected = new Map<string, BusinessKey>();
  #rows = new Map<string, Row>();
  #keys = new Map<string, BusinessKey>();
  #checked = new Map<string, boolean>();
  #listeners = new Set<SelectionListener<Row>>();
  #version = 0;
  #view: SelectionStoreSnapshot<Row>;

  constructor(options: SelectionStoreOptions<Row> | string = {}) {
    const normalizedOptions: SelectionStoreOptions<Row> =
      typeof options === "string" ? { keyField: options } : options;
    const resolved = resolveKeySelector(
      normalizedOptions.key ??
        normalizedOptions.keySelector ??
        normalizedOptions.businessKey,
      normalizedOptions.keyField,
    );
    this.keyField = resolved.field;
    this.#keySelector = resolved.selector;
    this.#normalizeContext = resolveNormalizeContext({
      keySelector: resolved.selector,
      keyField: resolved.field,
      checkedSelector:
        normalizedOptions.checked ?? normalizedOptions.checkedSelector,
      checkedField: normalizedOptions.checkedField,
    });
    this.#predicate = normalizedOptions.predicate;

    const initialKeys =
      normalizedOptions.initialSelectedKeys ?? normalizedOptions.selectedKeys;
    if (initialKeys) {
      this.#replaceSelection(initialKeys);
    }
    this.#view = this.#buildView();
  }

  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#selected.size;
  }

  get count(): number {
    return this.#selected.size;
  }

  get selected(): readonly BusinessKey[] {
    return this.#view.selectedKeys;
  }

  get selectedKeys(): readonly BusinessKey[] {
    return this.#view.selectedKeys;
  }

  get selectedKeySet(): ReadonlySet<BusinessKey> {
    return this.#view.selectedKeySet;
  }

  getSelectedKeys(): readonly BusinessKey[] {
    return this.#view.selectedKeys;
  }

  getSelectedCount(): number {
    return this.#selected.size;
  }

  get predicate(): RowPredicate<Row> | undefined {
    return this.#predicate;
  }

  setPredicate(predicate: RowPredicate<Row> | undefined): void {
    this.#predicate = predicate;
    this.#commit();
  }

  keyOf(row: Row, index = 0): BusinessKey {
    return readBusinessKey(row, this.#keySelector, index);
  }

  /**
   * Always validate a full snapshot before it can influence selection or the
   * adapter. Duplicate and missing keys are fatal by design.
   */
  observe(
    input: TablePageInput<Row>,
    options: ObserveOptions = {},
  ): NormalizedSnapshot<Row> {
    const snapshot = normalizeSnapshot(
      input,
      this.#normalizeContext,
      Date.now(),
    );
    this.ingest(snapshot, options);
    return snapshot;
  }

  ingest(
    snapshot: NormalizedSnapshot<Row>,
    options: ObserveOptions = {},
  ): void {
    for (const row of snapshot.rows) {
      const token = keyToken(row.key);
      this.#rows.set(token, row.row);
      this.#keys.set(token, row.key);
      this.#checked.set(token, row.checked);
      if (options.adoptChecked && row.checked) {
        if (
          this.#predicate === undefined ||
          this.#matches(row.row, row.index, row.checked, snapshot)
        ) {
          this.#selected.set(token, row.key);
        }
      }
    }

    if (options.pruneStale) {
      const predicate = this.#predicate;
      if (predicate !== undefined) {
        for (const row of snapshot.rows) {
          const token = keyToken(row.key);
          if (
            this.#selected.has(token) &&
            !this.#matches(row.row, row.index, row.checked, snapshot)
          ) {
            this.#selected.delete(token);
          }
        }
      }
    }

    if (options.pruneMissing) {
      for (const token of this.#selected.keys()) {
        if (!this.#rows.has(token)) {
          this.#selected.delete(token);
        }
      }
    }

    this.#commit();
  }

  // Common integration aliases.
  setRows(input: TablePageInput<Row>, options?: ObserveOptions) {
    return this.observe(input, options);
  }

  update(input: TablePageInput<Row>, options?: ObserveOptions) {
    return this.observe(input, options);
  }

  hydrate(input: TablePageInput<Row>, options?: ObserveOptions) {
    return this.observe(input, options);
  }

  /**
   * Reconcile a page with the predicate. Only rows visible in this snapshot
   * can be proven stale; rows on other pages stay selected.
   */
  reconcile(
    input: TablePageInput<Row>,
    predicate: RowPredicate<Row> | undefined = this.#predicate,
    options: ObserveOptions = {},
  ): NormalizedSnapshot<Row> {
    const snapshot = normalizeSnapshot(
      input,
      this.#normalizeContext,
      Date.now(),
    );
    this.ingest(snapshot, {
      ...options,
      pruneStale: false,
      pruneMissing: false,
    });
    if (predicate !== undefined) {
      for (const row of snapshot.rows) {
        const token = keyToken(row.key);
        if (
          this.#selected.has(token) &&
          !this.#matches(row.row, row.index, row.checked, snapshot, predicate)
        ) {
          this.#selected.delete(token);
        }
      }
    }
    if (options.pruneMissing) {
      for (const token of this.#selected.keys()) {
        if (!this.#rows.has(token)) {
          this.#selected.delete(token);
        }
      }
    }
    this.#commit();
    return snapshot;
  }

  /**
   * Prune selected keys using the latest observed rows. Missing row data is
   * retained unless `pruneMissing` is explicitly requested, which preserves
   * cross-page selection.
   */
  prune(
    predicate: RowPredicate<Row> | undefined = this.#predicate,
    options: { pruneMissing?: boolean } = {},
  ): readonly BusinessKey[] {
    const removed: BusinessKey[] = [];
    if (predicate !== undefined) {
      const snapshot = this.#currentSnapshot();
      for (const [token, key] of this.#selected) {
        const row = this.#rows.get(token);
        if (row === undefined) {
          continue;
        }
        const checked = this.#checked.get(token) ?? false;
        const state = snapshot.byKey.get(token);
        if (!predicate(row, this.#context(key, state?.index ?? 0, checked, snapshot))) {
          this.#selected.delete(token);
          removed.push(key);
        }
      }
    }
    if (options.pruneMissing) {
      for (const [token, key] of this.#selected) {
        if (!this.#rows.has(token)) {
          this.#selected.delete(token);
          removed.push(key);
        }
      }
    }
    if (removed.length > 0) {
      this.#commit();
    }
    return removed;
  }

  select(key: BusinessKey): boolean {
    assertBusinessKey(key);
    const token = keyToken(key);
    if (this.#selected.has(token)) {
      return false;
    }
    this.#selected.set(token, this.#keys.get(token) ?? key);
    this.#commit();
    return true;
  }

  selectRow(row: Row, index = 0): BusinessKey {
    const key = readBusinessKey(row, this.#keySelector, index);
    const token = keyToken(key);
    this.#rows.set(token, row);
    this.#keys.set(token, key);
    this.select(key);
    return key;
  }

  selectMany(keys: Iterable<BusinessKey>): readonly BusinessKey[] {
    const candidates = this.#validateKeys(keys);
    const added: BusinessKey[] = [];
    for (const key of candidates) {
      if (this.select(key)) {
        added.push(key);
      }
    }
    return added;
  }

  add(key: BusinessKey): boolean {
    return this.select(key);
  }

  setSelected(key: BusinessKey, selected: boolean): boolean {
    return selected ? this.select(key) : this.deselect(key);
  }

  toggle(key: BusinessKey): boolean {
    assertBusinessKey(key);
    return this.#selected.has(keyToken(key)) ? this.deselect(key) : this.select(key);
  }

  toggleRow(row: Row, index = 0): boolean {
    return this.toggle(readBusinessKey(row, this.#keySelector, index));
  }

  deselect(key: BusinessKey): boolean {
    assertBusinessKey(key);
    const token = keyToken(key);
    if (!this.#selected.has(token)) {
      return false;
    }
    this.#selected.delete(token);
    this.#commit();
    return true;
  }

  remove(key: BusinessKey): boolean {
    return this.deselect(key);
  }

  deselectMany(keys: Iterable<BusinessKey>): readonly BusinessKey[] {
    const candidates = this.#validateKeys(keys);
    const removed: BusinessKey[] = [];
    for (const key of candidates) {
      if (this.deselect(key)) {
        removed.push(key);
      }
    }
    return removed;
  }

  clear(): void {
    if (this.#selected.size === 0) {
      return;
    }
    this.#selected.clear();
    this.#commit();
  }

  clearSelection(): void {
    this.clear();
  }

  replace(keys: Iterable<BusinessKey>): void {
    const candidates = this.#validateKeys(keys);
    this.#replaceSelection(candidates);
    this.#commit();
  }

  setSelectedKeys(keys: Iterable<BusinessKey>): void {
    this.replace(keys);
  }

  load(keys: Iterable<BusinessKey>): void {
    this.replace(keys);
  }

  has(key: BusinessKey): boolean {
    assertBusinessKey(key);
    return this.#selected.has(keyToken(key));
  }

  isSelected(key: BusinessKey): boolean {
    return this.has(key);
  }

  isRowSelected(row: Row, index = 0): boolean {
    return this.has(readBusinessKey(row, this.#keySelector, index));
  }

  get(key: BusinessKey): BusinessKey | undefined {
    assertBusinessKey(key);
    return this.#selected.get(keyToken(key));
  }

  getRow(key: BusinessKey): Row | undefined {
    assertBusinessKey(key);
    return this.#rows.get(keyToken(key));
  }

  getSelectedRows(): readonly Row[] {
    const rows: Row[] = [];
    for (const token of this.#selected.keys()) {
      const row = this.#rows.get(token);
      if (row !== undefined) {
        rows.push(row);
      }
    }
    return rows;
  }

  /** Strict variant used by RPA flows that cannot tolerate an unloaded target. */
  getSelectedRowsStrict(): readonly Row[] {
    const rows: Row[] = [];
    for (const [token, key] of this.#selected) {
      const row = this.#rows.get(token);
      if (row === undefined) {
        throw new RowNotFoundError(key);
      }
      rows.push(row);
    }
    return rows;
  }

  isEligible(key: BusinessKey): boolean {
    assertBusinessKey(key);
    const row = this.#rows.get(keyToken(key));
    if (row === undefined) {
      return this.#predicate === undefined;
    }
    const checked = this.#checked.get(keyToken(key)) ?? false;
    const snapshot = this.#currentSnapshot();
    const state = snapshot.byKey.get(keyToken(key));
    return this.#predicate === undefined
      ? true
      : this.#predicate(
          row,
          this.#context(key, state?.index ?? 0, checked, snapshot),
        );
  }

  selectMatching(
    input: TablePageInput<Row>,
    predicate: RowPredicate<Row> | undefined = this.#predicate,
  ): readonly BusinessKey[] {
    const snapshot = this.observe(input);
    const added: BusinessKey[] = [];
    for (const row of snapshot.rows) {
      if (
        predicate === undefined ||
        this.#matches(row.row, row.index, row.checked, snapshot, predicate)
      ) {
        if (this.select(row.key)) {
          added.push(row.key);
        }
      }
    }
    return added;
  }

  selectVisible(
    predicate: RowPredicate<Row> | undefined = this.#predicate,
  ): readonly BusinessKey[] {
    const added: BusinessKey[] = [];
    const snapshot = this.#currentSnapshot();
    for (const [token, key] of this.#keys) {
      const row = this.#rows.get(token);
      if (row === undefined) {
        continue;
      }
      const state = snapshot.byKey.get(token);
      if (
        predicate === undefined ||
        predicate(
          row,
          this.#context(
            key,
            state?.index ?? 0,
            this.#checked.get(token) ?? false,
            snapshot,
          ),
        )
      ) {
        if (this.select(key)) {
          added.push(key);
        }
      }
    }
    return added;
  }

  getSnapshot(): SelectionStoreSnapshot<Row> {
    return this.#view;
  }

  getSelection(): SelectionStoreSnapshot<Row> {
    return this.#view;
  }

  subscribe(listener: SelectionListener<Row>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onChange(listener: SelectionListener<Row>): () => void {
    return this.subscribe(listener);
  }

  toJSON(): SelectionStoreJson {
    return {
      version: 1,
      keyField: this.keyField,
      selectedKeys: [...this.#selected.values()],
    };
  }

  static fromJSON<Row extends object = Record<string, unknown>>(
    value: SelectionStoreJson | string,
    options: SelectionStoreOptions<Row> = {},
  ): TableSelectionStore<Row> {
    const parsed =
      typeof value === "string"
        ? (JSON.parse(value) as SelectionStoreJson)
        : value;
    return new TableSelectionStore<Row>({
      ...options,
      keyField: options.keyField ?? parsed.keyField,
      initialSelectedKeys: parsed.selectedKeys,
    });
  }

  #matches(
    row: Row,
    index: number,
    checked: boolean,
    snapshot: NormalizedSnapshot<Row>,
    predicate: RowPredicate<Row> = this.#predicate!,
  ): boolean {
    const key = this.#keyOfRow(row, index);
    return predicate(row, {
      key,
      keyField: this.keyField,
      index,
      checked,
      snapshot,
    });
  }

  #keyOfRow(row: Row, index: number): BusinessKey {
    try {
      return readBusinessKey(row, this.#keySelector, index);
    } catch {
      return (row as Record<string, unknown>)[this.keyField] as BusinessKey;
    }
  }

  #context(
    key: BusinessKey,
    index: number,
    checked: boolean,
    snapshot: NormalizedSnapshot<Row> = this.#currentSnapshot(),
  ): RowContext<Row> {
    return {
      key,
      keyField: this.keyField,
      index,
      checked,
      snapshot,
    };
  }

  #currentSnapshot(): NormalizedSnapshot<Row> {
    const rows: SnapshotRowState<Row>[] = [];
    const byKey = new Map<string, SnapshotRowState<Row>>();
    const checkedKeys = new Set<string>();
    for (const [token, key] of this.#keys) {
      const row = this.#rows.get(token);
      if (row === undefined) {
        continue;
      }
      const checked = this.#checked.get(token) ?? false;
      if (checked) {
        checkedKeys.add(token);
      }
      const state: SnapshotRowState<Row> = {
        key,
        row,
        checked,
        checkedKnown: this.#checked.has(token),
        disabled: false,
        index: rows.length,
      };
      rows.push(state);
      byKey.set(token, state);
    }
    return {
      rows,
      byKey,
      checkedKeys,
      page: undefined,
      pageSize: undefined,
      total: undefined,
      sort: undefined,
      filters: undefined,
      revision: undefined,
      capturedAt: Date.now(),
      url: undefined,
    };
  }

  #validateKeys(keys: Iterable<BusinessKey>): BusinessKey[] {
    const result: BusinessKey[] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const key of keys) {
      assertBusinessKey(key, index);
      const token = keyToken(key);
      if (seen.has(token)) {
        throw new DuplicateBusinessKeyError(key, undefined, index);
      }
      seen.add(token);
      result.push(key);
      index += 1;
    }
    return result;
  }

  #replaceSelection(keys: Iterable<BusinessKey>): void {
    const candidates = this.#validateKeys(keys);
    this.#selected.clear();
    for (const key of candidates) {
      const token = keyToken(key);
      this.#selected.set(token, this.#keys.get(token) ?? key);
    }
  }

  #buildView(): SelectionStoreSnapshot<Row> {
    const selectedKeys = [...this.#selected.values()];
    const selectedKeySet = new Set(selectedKeys);
    const rowsByKey = new Map<BusinessKey, Row>();
    for (const token of this.#selected.keys()) {
      const row = this.#rows.get(token);
      if (row !== undefined) {
        rowsByKey.set(this.#selected.get(token)!, row);
      }
    }
    return {
      version: this.#version,
      selectedKeys,
      selectedKeySet,
      selectedCount: selectedKeys.length,
      observedKeys: [...this.#keys.values()],
      rowsByKey,
    };
  }

  #commit(): void {
    this.#version += 1;
    this.#view = this.#buildView();
    for (const listener of this.#listeners) {
      listener(this.#view);
    }
  }
}
