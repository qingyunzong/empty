import type { BusinessKey } from "./keys.ts";

export type { BusinessKey };

export type MaybePromise<T> = T | Promise<T>;

export type KeySelector<Row> =
  | string
  | ((row: Row, index: number) => BusinessKey);

export type CheckedSelector<Row> =
  | string
  | ((row: Row, index: number) => boolean | undefined);

export interface RowContext<Row> {
  key: BusinessKey;
  keyField: string;
  index: number;
  checked: boolean;
  snapshot: NormalizedSnapshot<Row>;
}

/**
 * Predicates are evaluated against the freshest row data available, never
 * against a cached row or a DOM index.
 */
export type RowPredicate<Row> = (
  row: Row,
  context: RowContext<Row>,
) => boolean;

export interface SnapshotRow<Row> {
  key?: BusinessKey;
  row?: Row;
  /** Some table components call the row payload `values` or `data`. */
  values?: Row;
  data?: Row;
  checked?: boolean;
  disabled?: boolean;
  index?: number;
}

export type SnapshotRowInput<Row> = Row | SnapshotRow<Row>;

export interface TablePage<Row> {
  rows: readonly SnapshotRowInput<Row>[];
  checkedKeys?: Iterable<BusinessKey>;
  selectedKeys?: Iterable<BusinessKey>;
  selectedRowKeys?: Iterable<BusinessKey>;
  uncheckedKeys?: Iterable<BusinessKey>;
  page?: number;
  pageSize?: number;
  total?: number;
  sort?: unknown;
  filters?: unknown;
  revision?: string | number;
  capturedAt?: number;
  url?: string;
}

export type TablePageInput<Row> =
  | TablePage<Row>
  | readonly SnapshotRowInput<Row>[];

export interface SnapshotRowState<Row> {
  key: BusinessKey;
  row: Row;
  checked: boolean;
  checkedKnown: boolean;
  disabled: boolean;
  index: number;
}

export interface NormalizedSnapshot<Row> {
  rows: readonly SnapshotRowState<Row>[];
  byKey: ReadonlyMap<string, SnapshotRowState<Row>>;
  checkedKeys: ReadonlySet<string>;
  page: number | undefined;
  pageSize: number | undefined;
  total: number | undefined;
  sort: unknown;
  filters: unknown;
  revision: string | number | undefined;
  capturedAt: number;
  url: string | undefined;
}

export interface SnapshotOptions<Row> {
  keySelector?: KeySelector<Row>;
  keyField?: string;
  checkedField?: string;
  checkedSelector?: CheckedSelector<Row>;
  disabledField?: string;
  capturedAt?: number;
}

export interface SelectionStoreSnapshot<Row> {
  version: number;
  selectedKeys: readonly BusinessKey[];
  selectedKeySet: ReadonlySet<BusinessKey>;
  selectedCount: number;
  observedKeys: readonly BusinessKey[];
  rowsByKey: ReadonlyMap<BusinessKey, Row>;
}

export interface SelectionStoreOptions<Row> {
  keyField?: string;
  key?: KeySelector<Row>;
  keySelector?: KeySelector<Row>;
  businessKey?: KeySelector<Row>;
  checkedField?: string;
  checked?: CheckedSelector<Row>;
  checkedSelector?: CheckedSelector<Row>;
  initialSelectedKeys?: Iterable<BusinessKey>;
  selectedKeys?: Iterable<BusinessKey>;
  predicate?: RowPredicate<Row>;
}

export interface ObserveOptions {
  /** Remove selected keys that are visible in this page and fail the predicate. */
  pruneStale?: boolean;
  /** Also remove selected keys for which no row data has ever been observed. */
  pruneMissing?: boolean;
  /** Add rows that the UI already shows as checked to the target set. */
  adoptChecked?: boolean;
}

export type RowAction = "select" | "deselect";

export type RowActionStatus =
  | "selected"
  | "deselected"
  | "already-selected"
  | "already-deselected"
  | "skipped-predicate"
  | "skipped-journal"
  | "failed";

export interface RowActionResult<Row> {
  key: BusinessKey;
  action: RowAction;
  status: RowActionStatus;
  attempts: number;
  before: SnapshotRowState<Row> | undefined;
  after: SnapshotRowState<Row> | undefined;
  error?: unknown;
}

export interface SelectionRunResult<Row> {
  ok: boolean;
  results: readonly RowActionResult<Row>[];
  stopped: {
    key: BusinessKey;
    error: unknown;
  } | undefined;
}

export interface TableRpaAdapter<Row> {
  /** Capture the rows currently mounted in the virtualized page window. */
  snapshot?(): MaybePromise<TablePageInput<Row>>;
  captureSnapshot?(): MaybePromise<TablePageInput<Row>>;
  getPageSnapshot?(): MaybePromise<TablePageInput<Row>>;
  /**
   * Idempotently set the checkbox state. Implementations should compare the
   * current state and only click when a change is needed.
   */
  setRowChecked?(
    key: BusinessKey,
    checked: boolean,
    row?: Row,
  ): MaybePromise<void>;
  setChecked?(key: BusinessKey, checked: boolean, row?: Row): MaybePromise<void>;
  setRowSelection?(
    key: BusinessKey,
    checked: boolean,
    row?: Row,
  ): MaybePromise<void>;
  /** Scroll a virtualized row into the rendered window. */
  scrollToRow?(key: BusinessKey): MaybePromise<void>;
  scrollRowIntoView?(key: BusinessKey): MaybePromise<void>;
  /**
   * Navigate to the page containing a key (server-side pagination) and return
   * the resulting snapshot. Returning void is allowed; the controller will
   * capture a fresh snapshot afterwards.
   */
  locateRow?(key: BusinessKey): MaybePromise<TablePageInput<Row> | void>;
  revealRow?(key: BusinessKey): MaybePromise<TablePageInput<Row> | void>;
  /** Optional async iterable of every page, used by `runMatching`. */
  pages?():
    | Iterable<TablePageInput<Row>>
    | AsyncIterable<TablePageInput<Row>>;
  pageSnapshots?():
    | Iterable<TablePageInput<Row>>
    | AsyncIterable<TablePageInput<Row>>;
  /** Wait until the table stops re-rendering after a click. */
  waitForStable?(): MaybePromise<void>;
}

export interface SelectionControllerOptions<
  Row extends object = Record<string, unknown>,
> {
  adapter: TableRpaAdapter<Row>;
  store?: import("./store.ts").TableSelectionStore<Row>;
  journal?: import("./journal.ts").ActionJournal;
  keyField?: string;
  key?: KeySelector<Row>;
  keySelector?: KeySelector<Row>;
  businessKey?: KeySelector<Row>;
  checkedField?: string;
  checked?: CheckedSelector<Row>;
  checkedSelector?: CheckedSelector<Row>;
  predicate?: RowPredicate<Row>;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Throw on fatal errors (the default) or return a failed run result. */
  throwOnError?: boolean;
  /** Keep the target store synchronized with successful actions. */
  syncStore?: boolean;
  /** Try `locateRow` / `scrollToRow` when a key is not in the first snapshot. */
  autoReveal?: boolean;
}
