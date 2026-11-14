import {
  AdapterError,
  DisabledRowError,
  DuplicateBusinessKeyError,
  RowNotFoundError,
  SnapshotConfirmationError,
  TableSelectionError,
  isFatalSelectionError,
} from "./errors.ts";
import {
  assertBusinessKey,
  keyToken,
  readBusinessKey,
  resolveKeySelector,
} from "./keys.ts";
import { ActionJournal } from "./journal.ts";
import {
  findRowByKey,
  normalizeSnapshot,
  resolveNormalizeContext,
  type NormalizeContext,
} from "./snapshot.ts";
import { TableSelectionStore } from "./store.ts";
import type {
  BusinessKey,
  KeySelector,
  NormalizedSnapshot,
  ObserveOptions,
  RowAction,
  RowActionResult,
  RowContext,
  RowPredicate,
  SelectionControllerOptions,
  SelectionRunResult,
  SnapshotRowState,
  TablePageInput,
  TableRpaAdapter,
} from "./types.ts";

export type SelectionTarget<Row> = BusinessKey | Row;

const SNAPSHOT_METHODS = [
  "snapshot",
  "captureSnapshot",
  "getPageSnapshot",
  "readSnapshot",
  "getSnapshot",
] as const;

const SET_CHECKED_METHODS = [
  "setRowChecked",
  "setChecked",
  "setRowSelection",
  "setRowSelected",
  "setSelected",
  "checkRow",
  "clickCheckbox",
] as const;

const LOCATE_METHODS = ["locateRow", "revealRow", "goToRow", "findRow"] as const;

const SCROLL_METHODS = [
  "scrollToRow",
  "scrollRowIntoView",
] as const;

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

/**
 * Coordinates snapshots, predicates and idempotent checkbox writes.
 *
 * The controller never uses row indexes as identity and re-reads the row before
 * every action. A stale target is therefore skipped rather than clicked.
 */
export class TableSelectionController<
  Row extends object = Record<string, unknown>,
> {
  readonly store: TableSelectionStore<Row>;
  readonly journal: ActionJournal;
  readonly keyField: string;

  #adapter: TableRpaAdapter<Row>;
  #keySelector: KeySelector<Row>;
  #normalizeContext: NormalizeContext<Row>;
  #predicate: RowPredicate<Row> | undefined;
  #maxAttempts: number;
  #retryDelayMs: number;
  #throwOnError: boolean;
  #syncStore: boolean;
  #autoReveal: boolean;

  constructor(options: SelectionControllerOptions<Row>) {
    if (options === null || typeof options !== "object" || !options.adapter) {
      throw new TypeError("TableSelectionController requires an adapter.");
    }
    const store =
      options.store ??
      new TableSelectionStore<Row>({
        key: options.key ?? options.keySelector ?? options.businessKey,
        keyField: options.keyField,
        checked: options.checked ?? options.checkedSelector,
        checkedField: options.checkedField,
        predicate: options.predicate,
      });
    const resolved = resolveKeySelector(
      options.key ?? options.keySelector ?? options.businessKey,
      options.keyField ?? store.keyField,
    );

    this.#adapter = options.adapter;
    this.store = store;
    this.journal = options.journal ?? new ActionJournal();
    this.keyField = resolved.field;
    this.#keySelector = resolved.selector;
    this.#normalizeContext = resolveNormalizeContext({
      keySelector: resolved.selector,
      keyField: resolved.field,
      checkedSelector: options.checked ?? options.checkedSelector,
      checkedField: options.checkedField,
    });
    this.#predicate = options.predicate ?? store.predicate;
    this.#maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2));
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    this.#throwOnError = options.throwOnError ?? true;
    this.#syncStore = options.syncStore ?? true;
    this.#autoReveal = options.autoReveal ?? true;
  }

  get predicate(): RowPredicate<Row> | undefined {
    return this.#predicate;
  }

  setPredicate(predicate: RowPredicate<Row> | undefined): void {
    this.#predicate = predicate;
  }

  /** Capture and validate the currently mounted page window. */
  async capture(options: ObserveOptions = {}): Promise<NormalizedSnapshot<Row>> {
    const input = await this.#callSnapshot();
    return this.#ingest(input, options);
  }

  async syncPage(
    options: ObserveOptions = {},
  ): Promise<NormalizedSnapshot<Row>> {
    const snapshot = await this.capture(options);
    if (options.pruneStale && this.#predicate !== undefined) {
      for (const row of snapshot.rows) {
        if (
          this.store.has(row.key) &&
          !this.#evaluatePredicate(row, snapshot)
        ) {
          this.store.deselect(row.key);
        }
      }
    }
    return snapshot;
  }

  refresh(options: ObserveOptions = {}): Promise<NormalizedSnapshot<Row>> {
    return this.syncPage(options);
  }

  async select(key: BusinessKey): Promise<RowActionResult<Row>> {
    const result = await this.#setChecked(key, true);
    return this.#finishSingle(result);
  }

  async deselect(key: BusinessKey): Promise<RowActionResult<Row>> {
    const result = await this.#setChecked(key, false);
    return this.#finishSingle(result);
  }

  setChecked(
    key: BusinessKey,
    checked: boolean,
  ): Promise<RowActionResult<Row>> {
    return checked ? this.select(key) : this.deselect(key);
  }

  async selectMany(
    targets: SelectionTarget<Row> | Iterable<SelectionTarget<Row>>,
  ): Promise<SelectionRunResult<Row>> {
    return this.run(targets, true);
  }

  async deselectMany(
    targets: SelectionTarget<Row> | Iterable<SelectionTarget<Row>>,
  ): Promise<SelectionRunResult<Row>> {
    return this.run(targets, false);
  }

  async run(
    targets: SelectionTarget<Row> | Iterable<SelectionTarget<Row>>,
    checked = true,
  ): Promise<SelectionRunResult<Row>> {
    const keys = this.#materializeTargets(targets);
    const results: RowActionResult<Row>[] = [];
    let stopped: SelectionRunResult<Row>["stopped"];

    for (const key of keys) {
      const result = await this.#setChecked(key, checked);
      results.push(result);
      if (result.status === "failed") {
        stopped = { key, error: result.error };
        if (this.#throwOnError) {
          throw result.error;
        }
        break;
      }
    }

    return { ok: stopped === undefined, results, stopped };
  }

  runKeys(
    keys: SelectionTarget<Row> | Iterable<SelectionTarget<Row>>,
    checked = true,
  ): Promise<SelectionRunResult<Row>> {
    return this.run(keys, checked);
  }

  execute(
    targets: SelectionTarget<Row> | Iterable<SelectionTarget<Row>>,
    checked = true,
  ): Promise<SelectionRunResult<Row>> {
    return this.run(targets, checked);
  }

  /**
   * Collect every matching business key (across `adapter.pages()` when
   * available) and then select them. Keys are validated before the first click,
   * and each click rechecks the predicate against a fresh snapshot.
   */
  async runMatching(
    predicate: RowPredicate<Row> | undefined = this.#predicate,
    checked = true,
  ): Promise<SelectionRunResult<Row>> {
    const keys = await this.collectMatchingKeys(predicate);
    return this.run(keys, checked);
  }

  selectMatching(
    predicate: RowPredicate<Row> | undefined = this.#predicate,
  ): Promise<SelectionRunResult<Row>> {
    return this.runMatching(predicate, true);
  }

  deselectMatching(
    predicate: RowPredicate<Row> | undefined = this.#predicate,
  ): Promise<SelectionRunResult<Row>> {
    return this.runMatching(predicate, false);
  }

  async collectMatchingKeys(
    predicate: RowPredicate<Row> | undefined = this.#predicate,
  ): Promise<readonly BusinessKey[]> {
    const pages = this.#method(["pages", "pageSnapshots"]);
    if (pages === undefined) {
      const snapshot = await this.capture();
      return snapshot.rows
        .filter(
          (row) =>
            predicate === undefined ||
            this.#evaluatePredicate(row, snapshot, predicate),
        )
        .map((row) => row.key);
    }

    const keys: BusinessKey[] = [];
    const firstIndex = new Map<string, number>();
    let index = 0;
    const maybeIterable = pages() as
      | Iterable<TablePageInput<Row>>
      | AsyncIterable<TablePageInput<Row>>
      | Promise<Iterable<TablePageInput<Row>> | AsyncIterable<TablePageInput<Row>>>;
    const iterable: Iterable<TablePageInput<Row>> | AsyncIterable<TablePageInput<Row>> =
      typeof (maybeIterable as Promise<unknown>).then === "function"
        ? await (maybeIterable as Promise<
            Iterable<TablePageInput<Row>> | AsyncIterable<TablePageInput<Row>>
          >)
        : (maybeIterable as
            | Iterable<TablePageInput<Row>>
            | AsyncIterable<TablePageInput<Row>>);
    for await (const page of iterable) {
      const snapshot = this.#ingest(page, {});
      for (const row of snapshot.rows) {
        const token = keyToken(row.key);
        if (firstIndex.has(token)) {
          throw new DuplicateBusinessKeyError(
            row.key,
            firstIndex.get(token),
            index,
          );
        }
        firstIndex.set(token, index);
        index += 1;
        if (
          predicate !== undefined &&
          !this.#evaluatePredicate(row, snapshot, predicate)
        ) {
          continue;
        }
        keys.push(row.key);
      }
    }
    return keys;
  }

  async #setChecked(
    key: BusinessKey,
    desired: boolean,
  ): Promise<RowActionResult<Row>> {
    assertBusinessKey(key);
    const action: RowAction = desired ? "select" : "deselect";
    const prior = this.journal.get(action, key);
    if (prior?.status === "success") {
      return {
        key,
        action,
        status: "skipped-journal",
        attempts: 0,
        before: undefined,
        after: undefined,
      };
    }

    let before: SnapshotRowState<Row> | undefined;
    let after: SnapshotRowState<Row> | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let snapshot: NormalizedSnapshot<Row>;
      try {
        snapshot = await this.#captureForKey(key);
      } catch (error) {
        lastError = error;
        if (this.#isFatal(error) || attempt >= this.#maxAttempts) {
          break;
        }
        await this.#delay(attempt);
        continue;
      }

      const row = findRowByKey(snapshot, key);
      if (row === undefined) {
        lastError = new RowNotFoundError(key);
        if (attempt >= this.#maxAttempts) {
          break;
        }
        await this.#delay(attempt);
        continue;
      }

      before = row;
      if (this.#predicate !== undefined) {
        let matches = false;
        try {
          matches = this.#evaluatePredicate(row, snapshot);
        } catch (error) {
          lastError = error;
          break;
        }
        if (!matches) {
          return {
            key,
            action,
            status: "skipped-predicate",
            attempts: attempt - 1,
            before,
            after: undefined,
          };
        }
      }

      if (row.disabled && row.checked !== desired) {
        lastError = new DisabledRowError(key);
        break;
      }

      if (row.checked === desired) {
        this.journal.succeed(action, key, { source: "snapshot" });
        this.#syncSelection(key, desired);
        return {
          key,
          action,
          status: desired ? "already-selected" : "already-deselected",
          attempts: attempt - 1,
          before,
          after: row,
        };
      }

      this.journal.begin(action, key, { attempt });
      try {
        await this.#callSetChecked(key, desired, row.row);
        await this.#waitForStable();
        const confirmed = await this.capture();
        after = findRowByKey(confirmed, key);
        if (after === undefined) {
          throw new RowNotFoundError(key);
        }
        if (after.checked !== desired) {
          throw new SnapshotConfirmationError(key, desired, after.checked);
        }
        this.journal.succeed(action, key, {
          source: "confirmed",
          attempts: attempt,
          revision: confirmed.revision,
        });
        this.#syncSelection(key, desired);
        return {
          key,
          action,
          status: desired ? "selected" : "deselected",
          attempts: attempt,
          before,
          after,
        };
      } catch (error) {
        lastError = error;
        this.journal.fail(action, key, {
          attempt,
          message: error instanceof Error ? error.message : String(error),
        });
        if (this.#isFatal(error) || attempt >= this.#maxAttempts) {
          break;
        }
        await this.#delay(attempt);
      }
    }

    return {
      key,
      action,
      status: "failed",
      attempts: this.journal.get(action, key)?.attempts ?? 0,
      before,
      after,
      error: lastError ?? new TableSelectionError(
        "ADAPTER_ERROR",
        `Unable to ${desired ? "select" : "deselect"} ${JSON.stringify(key)}.`,
        { key },
      ),
    };
  }

  async #captureForKey(key: BusinessKey): Promise<NormalizedSnapshot<Row>> {
    let snapshot = await this.capture();
    if (findRowByKey(snapshot, key) !== undefined || !this.#autoReveal) {
      return snapshot;
    }

    const locateRow = this.#optionalMethod(LOCATE_METHODS);
    if (locateRow !== undefined) {
      let located: TablePageInput<Row> | void;
      try {
        located = (await locateRow(key)) as TablePageInput<Row> | void;
      } catch (error) {
        throw new AdapterError(
          `locateRow failed for business key ${JSON.stringify(key)}.`,
          { key, cause: error },
        );
      }
      snapshot =
        located === undefined
          ? await this.capture()
          : this.#ingest(located, {});
      if (findRowByKey(snapshot, key) !== undefined) {
        return snapshot;
      }
    }

    const scrollToRow = this.#optionalMethod(SCROLL_METHODS);
    if (scrollToRow !== undefined) {
      try {
        await scrollToRow(key);
      } catch (error) {
        throw new AdapterError(
          `scrollToRow failed for business key ${JSON.stringify(key)}.`,
          { key, cause: error },
        );
      }
      await this.#waitForStable();
      snapshot = await this.capture();
    }
    return snapshot;
  }

  #materializeTargets(
    targets: SelectionTarget<Row> | Iterable<SelectionTarget<Row>>,
  ): readonly BusinessKey[] {
    const values: SelectionTarget<Row>[] = [];
    if (
      isIterable(targets) &&
      typeof targets !== "string"
    ) {
      for (const target of targets) {
        values.push(target);
      }
    } else {
      values.push(targets as SelectionTarget<Row>);
    }

    const keys: BusinessKey[] = [];
    const seen = new Set<string>();
    values.forEach((target, index) => {
      const key =
        typeof target === "string" || typeof target === "number"
          ? target
          : readBusinessKey(target as Row, this.#keySelector, index);
      assertBusinessKey(key, index);
      const token = keyToken(key);
      if (seen.has(token)) {
        throw new DuplicateBusinessKeyError(key, undefined, index);
      }
      seen.add(token);
      keys.push(key);
    });
    return keys;
  }

  #ingest(
    input: TablePageInput<Row>,
    options: ObserveOptions,
  ): NormalizedSnapshot<Row> {
    const snapshot = normalizeSnapshot(
      input,
      this.#normalizeContext,
      Date.now(),
    );
    if (this.#syncStore) {
      this.store.ingest(snapshot, options);
    }
    return snapshot;
  }

  #evaluatePredicate(
    row: SnapshotRowState<Row>,
    snapshot: NormalizedSnapshot<Row>,
    predicate: RowPredicate<Row> | undefined = this.#predicate,
  ): boolean {
    if (predicate === undefined) {
      return true;
    }
    const context: RowContext<Row> = {
      key: row.key,
      keyField: this.keyField,
      index: row.index,
      checked: row.checked,
      snapshot,
    };
    try {
      return predicate(row.row, context);
    } catch (error) {
      throw new TableSelectionError(
        "PREDICATE_ERROR",
        `The predicate failed for business key ${JSON.stringify(row.key)}.`,
        { key: row.key, cause: error },
      );
    }
  }

  #syncSelection(key: BusinessKey, selected: boolean): void {
    if (!this.#syncStore) {
      return;
    }
    if (selected) {
      this.store.select(key);
    } else {
      this.store.deselect(key);
    }
  }

  async #callSnapshot(): Promise<TablePageInput<Row>> {
    const method = this.#method(SNAPSHOT_METHODS);
    if (method === undefined) {
      throw new AdapterError(
        "The adapter must expose snapshot() (or captureSnapshot/readSnapshot).",
      );
    }
    try {
      return (await method()) as TablePageInput<Row>;
    } catch (error) {
      throw new AdapterError("Capturing the table snapshot failed.", {
        cause: error,
      });
    }
  }

  async #callSetChecked(
    key: BusinessKey,
    checked: boolean,
    row: Row,
  ): Promise<void> {
    const method = this.#method(SET_CHECKED_METHODS);
    if (method === undefined) {
      throw new AdapterError(
        "The adapter must expose setRowChecked(key, checked, row).",
        { key },
      );
    }
    try {
      await method(key, checked, row);
    } catch (error) {
      throw new AdapterError(
        `Setting checkbox state failed for business key ${JSON.stringify(key)}.`,
        { key, cause: error },
      );
    }
  }

  async #waitForStable(): Promise<void> {
    const waitForStable = (this.#adapter as unknown as Record<string, unknown>)
      .waitForStable;
    if (typeof waitForStable !== "function") {
      return;
    }
    try {
      await waitForStable.call(this.#adapter);
    } catch (error) {
      throw new AdapterError("waitForStable failed.", { cause: error });
    }
  }

  #method(names: readonly string[]): ((...args: unknown[]) => unknown) | undefined {
    for (const name of names) {
      const candidate = (this.#adapter as unknown as Record<string, unknown>)[
        name
      ];
      if (typeof candidate === "function") {
        return candidate.bind(this.#adapter);
      }
    }
    return undefined;
  }

  #optionalMethod(
    names: readonly string[],
  ): ((...args: unknown[]) => unknown) | undefined {
    return this.#method(names);
  }

  #isFatal(error: unknown): boolean {
    if (isFatalSelectionError(error)) {
      return true;
    }
    return (
      error instanceof TableSelectionError &&
      error.code === "PREDICATE_ERROR"
    );
  }

  async #delay(attempt: number): Promise<void> {
    if (this.#retryDelayMs <= 0) {
      return;
    }
    const delay = this.#retryDelayMs * attempt;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    });
  }

  #finishSingle(result: RowActionResult<Row>): RowActionResult<Row> {
    if (result.status === "failed" && this.#throwOnError) {
      throw result.error;
    }
    return result;
  }
}

export interface RunTableSelectionOptions<
  Row extends object = Record<string, unknown>,
> extends SelectionControllerOptions<Row> {
  targets:
    | SelectionTarget<Row>
    | Iterable<SelectionTarget<Row>>;
  /** Desired state; defaults to true. (`checked` remains a selector option.) */
  checkedState?: boolean;
}

export async function runTableSelection<Row extends object>(
  options: RunTableSelectionOptions<Row>,
): Promise<SelectionRunResult<Row>> {
  const controller = new TableSelectionController<Row>(options);
  return controller.run(options.targets, options.checkedState ?? true);
}

export function createTableSelectionController<Row extends object>(
  options: SelectionControllerOptions<Row>,
): TableSelectionController<Row> {
  return new TableSelectionController<Row>(options);
}

export function defineTableAdapter<Row extends object>(
  adapter: TableRpaAdapter<Row>,
): TableRpaAdapter<Row> {
  return adapter;
}

export const runSelection = runTableSelection;
