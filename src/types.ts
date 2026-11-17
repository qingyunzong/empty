export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ListStrategyKind = "atomic" | "set" | "keyed";

export type MergeKeySelector = (
  item: unknown,
  index: number,
  path: string,
) => string | number;

export type MergeIdentity = (item: unknown) => string | number;

/**
 * Declarative list merge behaviour. The canonical fields are `strategy`,
 * `key`/`keys` and `identity`; the aliases make it easy to consume schema
 * metadata from systems that call the same idea `kind`, `mergeKey`, etc.
 */
export interface ListMergeSpec {
  strategy?: ListStrategyKind;
  kind?: ListStrategyKind;
  mode?: ListStrategyKind;
  merge?: ListStrategyKind;
  type?: ListStrategyKind;
  key?: string | readonly string[] | MergeKeySelector;
  keys?: string | readonly string[];
  mergeKey?: string | readonly string[];
  mergeKeys?: string | readonly string[];
  identity?: MergeIdentity | string;
}

export type ListSpecInput = ListStrategyKind | ListMergeSpec;

export interface ListRule extends ListMergeSpec {
  path: string | readonly string[];
}

export interface ListResolutionContext {
  /** JSON-Pointer-like path of the list field, excluding item selectors. */
  path: string;
  segments: readonly string[];
  base: unknown;
  current: unknown;
  desired: unknown;
}

export type ConflictResolution = "current" | "desired";

export interface ThreeWayMergeOptions {
  /** Map of dot paths (`spec.containers`) or JSON Pointers to list rules. */
  lists?: Record<string, ListSpecInput>;
  listStrategies?: Record<string, ListSpecInput>;
  listMerge?: Record<string, ListSpecInput>;
  mergeKeys?: Record<string, ListSpecInput>;
  /** Ordered rules; the most specific matching rule wins. */
  listRules?: readonly ListRule[];
  defaultListStrategy?: ListSpecInput;
  defaultList?: ListSpecInput;
  arrayStrategy?: ListSpecInput;
  conflictResolution?: ConflictResolution;
  resolveConflict?: ConflictResolution;
  prefer?: ConflictResolution;
  /** Optional dynamic resolver, evaluated before declarative rules. */
  resolveList?: (
    context: ListResolutionContext,
  ) => ListSpecInput | undefined;
}

export interface FieldState {
  present: boolean;
  value?: unknown;
}

export type ConflictKind =
  | "modify"
  | "add"
  | "delete-modify"
  | "modify-delete";

export interface MergeConflict {
  /** Stable JSON-Pointer-like path, e.g. `/spec/containers/[name=web]/image`. */
  path: string;
  pathSegments: readonly string[];
  kind: ConflictKind;
  base: FieldState;
  current: FieldState;
  desired: FieldState;
  /** Value selected for the merged document after conflict resolution. */
  resolved: FieldState;
  winner: ConflictResolution;
}

export interface PatchReplace {
  op: "replace";
  value: unknown;
}

export interface PatchRemove {
  op: "remove";
}

export interface PatchMerge {
  op: "merge";
  fields: Record<string, MergePatch>;
}

/**
 * A serializable, null-safe merge patch. Arrays are replaced as a whole after
 * the list strategy has produced their merged value, which makes re-applying a
 * patch idempotent even for set and keyed lists.
 */
export type MergePatch = PatchReplace | PatchRemove | PatchMerge;

export interface MergeResult<T = unknown> {
  merged: T;
  patch: MergePatch;
  conflicts: readonly MergeConflict[];
  hasConflicts: boolean;
}
