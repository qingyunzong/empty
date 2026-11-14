import {
  DuplicateBusinessKeyError,
  MissingBusinessKeyError,
} from "./errors.ts";
import {
  assertBusinessKey,
  keyToken,
  readBusinessKey,
  readField,
  resolveKeySelector,
} from "./keys.ts";
import type {
  CheckedSelector,
  KeySelector,
  NormalizedSnapshot,
  SnapshotOptions,
  SnapshotRowInput,
  SnapshotRowState,
  TablePage,
  TablePageInput,
} from "./types.ts";

function isWrappedRow<Row>(
  value: SnapshotRowInput<Row>,
  keyField: string,
): value is Exclude<SnapshotRowInput<Row>, Row> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!("row" in record) && !("values" in record) && !("data" in record)) {
    return false;
  }
  if ("key" in record || "checked" in record || "disabled" in record) {
    return true;
  }
  // `{ row }` is a wrapper; `{ id: "x", row: ... }` is a raw row that happens
  // to have a `row` field.
  return !(keyField in record);
}

function readChecked<Row>(
  row: Row,
  index: number,
  checkedKeys: ReadonlySet<string>,
  uncheckedKeys: ReadonlySet<string>,
  token: string,
  checkedSelector: CheckedSelector<Row> | undefined,
  checkedField: string | undefined,
  explicit: boolean | undefined,
): { checked: boolean; known: boolean } {
  if (typeof explicit === "boolean") {
    return { checked: explicit, known: true };
  }
  if (checkedSelector !== undefined) {
    const value =
      typeof checkedSelector === "function"
        ? checkedSelector(row, index)
        : readField(row, checkedSelector);
    if (typeof value === "boolean") {
      return { checked: value, known: true };
    }
  } else {
    const fields = checkedField
      ? [checkedField]
      : ["checked", "selected", "isSelected"];
    for (const field of fields) {
      const value = readField(row, field);
      if (typeof value === "boolean") {
        return { checked: value, known: true };
      }
    }
  }
  if (checkedKeys.has(token)) {
    return { checked: true, known: true };
  }
  if (uncheckedKeys.has(token)) {
    return { checked: false, known: true };
  }
  return { checked: false, known: false };
}

function collectKeySet(
  values: Iterable<import("./keys.ts").BusinessKey> | undefined,
): Set<string> {
  const result = new Set<string>();
  if (values === undefined) {
    return result;
  }
  let index = 0;
  for (const value of values) {
    assertBusinessKey(value, index);
    const token = keyToken(value);
    if (result.has(token)) {
      throw new DuplicateBusinessKeyError(value, undefined, index);
    }
    result.add(token);
    index += 1;
  }
  return result;
}

export interface NormalizeContext<Row> {
  keySelector: KeySelector<Row>;
  keyField: string;
  checkedSelector: CheckedSelector<Row> | undefined;
  checkedField: string | undefined;
  disabledField: string;
}

export function resolveNormalizeContext<Row>(
  options: SnapshotOptions<Row> = {},
): NormalizeContext<Row> {
  const resolved = resolveKeySelector(options.keySelector, options.keyField);
  return {
    keySelector: resolved.selector,
    keyField: resolved.field,
    checkedSelector: options.checkedSelector,
    checkedField: options.checkedField,
    disabledField: options.disabledField ?? "disabled",
  };
}

export function normalizeSnapshot<Row>(
  input: TablePageInput<Row>,
  context: NormalizeContext<Row>,
  capturedAt?: number,
): NormalizedSnapshot<Row> {
  const page: TablePage<Row> = Array.isArray(input)
    ? { rows: input as readonly SnapshotRowInput<Row>[] }
    : (input as TablePage<Row>);

  if (page === null || typeof page !== "object" || !Array.isArray(page.rows)) {
    throw new TypeError("A table snapshot must contain a `rows` array.");
  }

  const checkedKeys = collectKeySet(page.checkedKeys ?? page.selectedKeys);
  const selectedRowKeys = collectKeySet(page.selectedRowKeys);
  const uncheckedKeys = collectKeySet(page.uncheckedKeys);
  const rows: SnapshotRowState<Row>[] = [];
  const byKey = new Map<string, SnapshotRowState<Row>>();
  const firstIndexByToken = new Map<string, number>();
  const normalizedCheckedKeys = new Set<string>();

  page.rows.forEach((entry, index) => {
    const wrapped = isWrappedRow(entry, context.keyField);
    const wrappedEntry = entry as { row?: Row; values?: Row; data?: Row };
    const row = wrapped
      ? wrappedEntry.row ?? wrappedEntry.values ?? wrappedEntry.data
      : (entry as Row);
    if (row === null || row === undefined) {
      throw new MissingBusinessKeyError({ index });
    }

    const explicitKey = wrapped
      ? (entry as { key?: unknown }).key
      : undefined;
    const key =
      explicitKey === undefined
        ? readBusinessKey(row, context.keySelector, index)
        : explicitKey;
    assertBusinessKey(key, index);
    const token = keyToken(key);

    if (byKey.has(token)) {
      throw new DuplicateBusinessKeyError(
        key,
        firstIndexByToken.get(token),
        index,
      );
    }

    const explicitChecked = wrapped
      ? (entry as { checked?: boolean }).checked
      : undefined;
    const checked = readChecked(
      row,
      index,
      checkedKeys,
      uncheckedKeys,
      token,
      context.checkedSelector,
      context.checkedField,
      explicitChecked,
    );
    const selectedByRowKey = checked.known
      ? checked
      : selectedRowKeys.has(token)
        ? { checked: true, known: true }
        : checked;
    const explicitDisabled = wrapped
      ? (entry as { disabled?: boolean }).disabled
      : undefined;
    const disabled =
      typeof explicitDisabled === "boolean"
        ? explicitDisabled
        : readField(row, context.disabledField) === true;

    const state: SnapshotRowState<Row> = {
      key,
      row,
      checked: selectedByRowKey.checked,
      checkedKnown: selectedByRowKey.known,
      disabled,
      index,
    };
    rows.push(state);
    byKey.set(token, state);
    firstIndexByToken.set(token, index);
    if (state.checked) {
      normalizedCheckedKeys.add(token);
    }
  });

  return {
    rows,
    byKey,
    checkedKeys: normalizedCheckedKeys,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    sort: page.sort,
    filters: page.filters,
    revision: page.revision,
    capturedAt: page.capturedAt ?? capturedAt ?? Date.now(),
    url: page.url,
  };
}

export function findRowByKey<Row>(
  snapshot: NormalizedSnapshot<Row>,
  key: import("./keys.ts").BusinessKey,
): SnapshotRowState<Row> | undefined {
  return snapshot.byKey.get(keyToken(key));
}
