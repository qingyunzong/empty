import type {
  ConflictKind,
  ConflictResolution,
  FieldState,
  ListMergeSpec,
  ListResolutionContext,
  ListRule,
  ListSpecInput,
  ListStrategyKind,
  MergeConflict,
  MergeKeySelector,
  MergePatch,
  MergeResult,
  ThreeWayMergeOptions,
} from "./types.ts";
import { createPatch } from "./patch.ts";
import {
  MergeError,
  assertAcyclic,
  cloneValue,
  compareStrings,
  deepEqual,
  formatPath,
  hasOwn,
  isPlainObject,
  matchesPathPattern,
  parsePathPattern,
  pathPatternSpecificity,
  readPathField,
  setOwn,
  stableStringify,
} from "./utils.ts";

interface FieldPresence {
  present: boolean;
  value?: unknown;
}

type ListMode = ListStrategyKind;

interface NormalizedListSpec {
  mode: ListMode;
  keyFields: readonly string[] | null;
  keySelector: MergeKeySelector | null;
  identity: ((item: unknown) => string | number) | null;
}

interface NormalizedRule {
  path: readonly string[];
  spec: NormalizedListSpec;
}

interface NormalizedOptions {
  defaultSpec: NormalizedListSpec;
  rules: readonly NormalizedRule[];
  resolver:
    | ((context: ListResolutionContext) => ListSpecInput | undefined)
    | undefined;
  resolution: ConflictResolution;
}

interface MergeContext {
  options: NormalizedOptions;
  /** Property path used to select list rules; excludes list item selectors. */
  schemaPath: readonly string[];
  /** User-facing path; includes keyed item selectors. */
  path: readonly string[];
  conflicts: MergeConflict[];
}

const ABSENT: FieldPresence = Object.freeze({ present: false });

function presence(value: unknown): FieldPresence {
  return value === undefined ? ABSENT : { present: true, value };
}

function readField(
  object: Record<string, unknown>,
  key: string,
): FieldPresence {
  if (!hasOwn(object, key) || object[key] === undefined) return ABSENT;
  return presence(object[key]);
}

function toFieldState(value: FieldPresence): FieldState {
  return value.present
    ? { present: true, value: cloneValue(value.value) }
    : { present: false };
}

function childContext(context: MergeContext, key: string): MergeContext {
  return {
    ...context,
    schemaPath: [...context.schemaPath, key],
    path: [...context.path, key],
  };
}

function itemContext(
  context: MergeContext,
  selector: string,
): MergeContext {
  return {
    ...context,
    path: [...context.path, selector],
  };
}

function parseListMode(value: unknown): ListMode | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).toLowerCase().replaceAll("_", "-");
  if (["atomic", "replace", "overwrite", "none"].includes(text)) {
    return "atomic";
  }
  if (["set", "collection", "unique"].includes(text)) return "set";
  if (["keyed", "map", "merge-key", "mergekey", "by-key", "key"].includes(text)) {
    return "keyed";
  }
  throw new MergeError(`Unknown list strategy: ${String(value)}`);
}

function normalizeKeyFields(value: unknown): readonly string[] | null {
  if (typeof value === "string") {
    return value === "" ? null : [value];
  }
  if (Array.isArray(value)) {
    const fields = value.map((item) => String(item)).filter(Boolean);
    return fields.length > 0 ? fields : null;
  }
  return null;
}

function normalizeListSpec(
  input: ListSpecInput | undefined,
  label: string,
): NormalizedListSpec {
  if (input === undefined) {
    return {
      mode: "atomic",
      keyFields: null,
      keySelector: null,
      identity: null,
    };
  }

  if (typeof input === "string") {
    const mode = parseListMode(input);
    if (mode === undefined) {
      throw new MergeError(`Unknown list strategy for ${label}: ${input}`);
    }
    return {
      mode,
      keyFields: mode === "keyed" ? ["name"] : null,
      keySelector: null,
      identity: null,
    };
  }

  if (typeof input !== "object" || input === null) {
    throw new MergeError(`Invalid list strategy for ${label}`);
  }

  const spec = input as ListMergeSpec;
  const declaredMode =
    parseListMode(spec.strategy) ??
    parseListMode(spec.kind) ??
    parseListMode(spec.mode) ??
    parseListMode(spec.merge) ??
    parseListMode(spec.type);

  const keySource =
    spec.mergeKeys ?? spec.keys ?? spec.mergeKey ?? spec.key;
  const keySelector =
    typeof keySource === "function" ? keySource : null;
  let keyFields = normalizeKeyFields(
    keySelector === null ? keySource : null,
  );

  let identity: ((item: unknown) => string | number) | null = null;
  if (typeof spec.identity === "function") {
    identity = spec.identity;
  } else if (typeof spec.identity === "string") {
    keyFields = normalizeKeyFields(spec.identity);
  }

  let mode = declaredMode;
  if (mode === undefined) {
    if (keySelector !== null || keyFields !== null) mode = "keyed";
    else if (identity !== null) mode = "set";
    else mode = "atomic";
  }

  if (mode === "keyed" && keySelector === null && keyFields === null) {
    keyFields = ["name"];
  }

  return {
    mode,
    keyFields,
    keySelector,
    identity,
  };
}

function parseResolution(
  options: ThreeWayMergeOptions,
): ConflictResolution {
  const value =
    options.conflictResolution ??
    options.resolveConflict ??
    options.prefer ??
    "current";
  if (value !== "current" && value !== "desired") {
    throw new MergeError(
      `Unknown conflict resolution: ${String(value)}; expected "current" or "desired"`,
    );
  }
  return value;
}

function addRuleMap(
  rules: NormalizedRule[],
  map: Record<string, ListSpecInput> | undefined,
  stringMeansKey = false,
): void {
  if (!map) return;
  for (const [path, spec] of Object.entries(map)) {
    rules.push({
      path: parsePathPattern(path),
      spec: normalizeListSpec(
        stringMeansKey && typeof spec === "string"
          ? { strategy: "keyed", key: spec }
          : spec,
        path,
      ),
    });
  }
}

function normalizeOptions(
  options: ThreeWayMergeOptions,
): NormalizedOptions {
  const rules: NormalizedRule[] = [];
  addRuleMap(rules, options.lists);
  addRuleMap(rules, options.listStrategies);
  addRuleMap(rules, options.listMerge);
  addRuleMap(rules, options.mergeKeys, true);

  if (options.listRules) {
    for (const rule of options.listRules as readonly ListRule[]) {
      rules.push({
        path: parsePathPattern(rule.path),
        spec: normalizeListSpec(
          rule,
          typeof rule.path === "string"
            ? rule.path
            : `/${rule.path.join("/")}`,
        ),
      });
    }
  }

  const defaultInput =
    options.defaultListStrategy ??
    options.defaultList ??
    options.arrayStrategy;

  return {
    defaultSpec: normalizeListSpec(defaultInput, "<default>"),
    rules,
    resolver: options.resolveList,
    resolution: parseResolution(options),
  };
}

function resolveListSpec(
  context: MergeContext,
  base: unknown,
  current: unknown,
  desired: unknown,
): NormalizedListSpec {
  if (context.options.resolver) {
    const resolved = context.options.resolver({
      path: formatPath(context.schemaPath),
      segments: [...context.schemaPath],
      base,
      current,
      desired,
    });
    if (resolved !== undefined) {
      return normalizeListSpec(
        resolved,
        formatPath(context.schemaPath),
      );
    }
  }

  let selected: NormalizedRule | undefined;
  let selectedScore = -1;
  for (const rule of context.options.rules) {
    const score = pathPatternSpecificity(rule.path, context.schemaPath);
    if (score >= selectedScore && score >= 0) {
      selected = rule;
      selectedScore = score;
    }
  }
  return selected?.spec ?? context.options.defaultSpec;
}

function recordConflict(
  context: MergeContext,
  kind: ConflictKind,
  base: FieldPresence,
  current: FieldPresence,
  desired: FieldPresence,
): FieldPresence {
  const winner = context.options.resolution;
  const resolved = winner === "desired" ? desired : current;
  context.conflicts.push({
    path: formatPath(context.path),
    pathSegments: [...context.path],
    kind,
    base: toFieldState(base),
    current: toFieldState(current),
    desired: toFieldState(desired),
    resolved: toFieldState(resolved),
    winner,
  });
  return resolved;
}

function mergeObjects(
  base: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  context: MergeContext,
): FieldPresence {
  const keys = new Set<string>([
    ...(base ? Object.keys(base) : []),
    ...Object.keys(current),
    ...Object.keys(desired),
  ]);
  const merged: Record<string, unknown> = {};

  for (const key of [...keys].sort(compareStrings)) {
    const child = childContext(context, key);
    const value = mergeValue(
      base ? readField(base, key) : ABSENT,
      readField(current, key),
      readField(desired, key),
      child,
    );
    if (value.present) setOwn(merged, key, value.value);
  }

  return presence(merged);
}

function mergeValue(
  base: FieldPresence,
  current: FieldPresence,
  desired: FieldPresence,
  context: MergeContext,
): FieldPresence {
  if (!current.present && !desired.present) return ABSENT;

  if (!current.present) {
    if (!desired.present) return ABSENT;
    if (!base.present) return desired;
    if (deepEqual(desired.value, base.value)) return ABSENT;
    return recordConflict(
      context,
      "delete-modify",
      base,
      current,
      desired,
    );
  }

  if (!desired.present) {
    if (!base.present) return current;
    if (deepEqual(current.value, base.value)) return ABSENT;
    return recordConflict(
      context,
      "modify-delete",
      base,
      current,
      desired,
    );
  }

  if (deepEqual(current.value, desired.value)) return current;

  if (!base.present) {
    if (Array.isArray(current.value) && Array.isArray(desired.value)) {
      return mergeList(ABSENT, current, desired, context);
    }
    if (
      isPlainObject(current.value) &&
      isPlainObject(desired.value)
    ) {
      return mergeObjects(undefined, current.value, desired.value, context);
    }
    return recordConflict(context, "add", base, current, desired);
  }

  if (deepEqual(current.value, base.value)) return desired;
  if (deepEqual(desired.value, base.value)) return current;

  if (Array.isArray(current.value) && Array.isArray(desired.value)) {
    return mergeList(base, current, desired, context);
  }

  if (
    isPlainObject(base.value) &&
    isPlainObject(current.value) &&
    isPlainObject(desired.value)
  ) {
    return mergeObjects(base.value, current.value, desired.value, context);
  }

  return recordConflict(context, "modify", base, current, desired);
}

function mergeList(
  base: FieldPresence,
  current: FieldPresence,
  desired: FieldPresence,
  context: MergeContext,
): FieldPresence {
  if (!Array.isArray(current.value) || !Array.isArray(desired.value)) {
    return recordConflict(context, "modify", base, current, desired);
  }

  const baseValue = Array.isArray(base.value) ? base.value : undefined;
  const spec = resolveListSpec(
    context,
    baseValue,
    current.value,
    desired.value,
  );

  if (spec.mode === "atomic") {
    return recordConflict(
      context,
      base.present ? "modify" : "add",
      base,
      current,
      desired,
    );
  }

  if (spec.mode === "set") {
    return presence(
      mergeSet(
        baseValue ?? [],
        current.value,
        desired.value,
        spec,
        context,
      ),
    );
  }

  return presence(
    mergeKeyed(
      baseValue ?? [],
      current.value,
      desired.value,
      spec,
      context,
    ),
  );
}

interface IndexedItem {
  id: string;
  display: string;
  value: unknown;
}

function keyValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return stableStringify(value);
}

function keyedIdentity(
  item: unknown,
  index: number,
  spec: NormalizedListSpec,
  listPath: string,
  label: string,
): IndexedItem {
  if (spec.keySelector) {
    const selected = spec.keySelector(item, index, listPath);
    if (selected === undefined || selected === null) {
      throw new MergeError(
        `Missing merge key in ${label} item at ${listPath}`,
      );
    }
    return {
      id: `selector:${typeof selected}:${String(selected)}`,
      display: `[key=${keyValueText(selected)}]`,
      value: item,
    };
  }

  const fields = spec.keyFields ?? ["name"];
  const parts: string[] = [];
  const identityParts: string[] = [];
  for (const field of fields) {
    const read = readPathField(item, field);
    if (!read.present) {
      throw new MergeError(
        `Missing merge key "${field}" in ${label} item at ${listPath}`,
      );
    }
    parts.push(`${field}=${keyValueText(read.value)}`);
    identityParts.push(`${field}:${stableStringify(read.value)}`);
  }
  return {
    id: `fields:${identityParts.join("|")}`,
    display: `[${parts.join(",")}]`,
    value: item,
  };
}

function setIdentity(
  item: unknown,
  index: number,
  spec: NormalizedListSpec,
  listPath: string,
  label: string,
): IndexedItem {
  if (spec.identity) {
    const selected = spec.identity(item);
    return {
      id: `identity:${typeof selected}:${String(selected)}`,
      display: `[#${keyValueText(selected)}]`,
      value: item,
    };
  }
  if (spec.keySelector || spec.keyFields) {
    return keyedIdentity(item, index, spec, listPath, label);
  }
  return {
    id: `value:${stableStringify(item)}`,
    display: `[#${stableStringify(item)}]`,
    value: item,
  };
}

function indexItems(
  items: readonly unknown[],
  spec: NormalizedListSpec,
  listPath: string,
  label: string,
  keyer: (
    item: unknown,
    index: number,
    spec: NormalizedListSpec,
    listPath: string,
    label: string,
  ) => IndexedItem,
  dedupe = false,
): Map<string, IndexedItem> {
  const indexed = new Map<string, IndexedItem>();
  for (let index = 0; index < items.length; index += 1) {
    const entry = keyer(
      items[index],
      index,
      spec,
      listPath,
      label,
    );
    const existing = indexed.get(entry.id);
    if (existing) {
      if (dedupe && deepEqual(existing.value, entry.value)) continue;
      throw new MergeError(
        `Duplicate ${dedupe ? "set identity" : "merge key"} ${entry.display} in ${label} list at ${listPath}`,
      );
    }
    indexed.set(entry.id, entry);
  }
  return indexed;
}

function orderedIds(
  base: Map<string, IndexedItem>,
  current: Map<string, IndexedItem>,
  desired: Map<string, IndexedItem>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const map of [base, current, desired]) {
    for (const id of map.keys()) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function indexedPresence(
  map: Map<string, IndexedItem>,
  id: string,
): FieldPresence {
  const entry = map.get(id);
  return entry ? presence(entry.value) : ABSENT;
}

function mergeKeyed(
  baseItems: readonly unknown[],
  currentItems: readonly unknown[],
  desiredItems: readonly unknown[],
  spec: NormalizedListSpec,
  context: MergeContext,
): unknown[] {
  const listPath = formatPath(context.path);
  const base = indexItems(
    baseItems,
    spec,
    listPath,
    "base",
    keyedIdentity,
  );
  const current = indexItems(
    currentItems,
    spec,
    listPath,
    "current",
    keyedIdentity,
  );
  const desired = indexItems(
    desiredItems,
    spec,
    listPath,
    "desired",
    keyedIdentity,
  );

  const result: unknown[] = [];
  for (const id of orderedIds(base, current, desired)) {
    const display =
      position(base, id) ?? position(current, id) ?? position(desired, id);
    if (!display) continue;
    const itemCtx = itemContext(context, display.display);
    const merged = mergeValue(
      indexedPresence(base, id),
      indexedPresence(current, id),
      indexedPresence(desired, id),
      itemCtx,
    );
    if (merged.present) result.push(merged.value);
  }
  return result;
}

function position(
  map: Map<string, IndexedItem>,
  id: string,
): IndexedItem | undefined {
  return map.get(id);
}

function mergeSet(
  baseItems: readonly unknown[],
  currentItems: readonly unknown[],
  desiredItems: readonly unknown[],
  spec: NormalizedListSpec,
  context: MergeContext,
): unknown[] {
  const listPath = formatPath(context.path);
  const base = indexItems(
    baseItems,
    spec,
    listPath,
    "base",
    setIdentity,
    true,
  );
  const current = indexItems(
    currentItems,
    spec,
    listPath,
    "current",
    setIdentity,
    true,
  );
  const desired = indexItems(
    desiredItems,
    spec,
    listPath,
    "desired",
    setIdentity,
    true,
  );

  const result: unknown[] = [];
  for (const id of orderedIds(base, current, desired)) {
    const merged = mergeSetElement(
      indexedPresence(base, id),
      indexedPresence(current, id),
      indexedPresence(desired, id),
      context,
    );
    if (merged.present) result.push(merged.value);
  }
  return result;
}

function mergeSetElement(
  base: FieldPresence,
  current: FieldPresence,
  desired: FieldPresence,
  context: MergeContext,
): FieldPresence {
  if (!current.present && !desired.present) return ABSENT;
  if (!current.present) {
    if (!base.present) return desired;
    if (deepEqual(desired.value, base.value)) return ABSENT;
    return recordConflict(
      context,
      "delete-modify",
      base,
      current,
      desired,
    );
  }
  if (!desired.present) {
    if (!base.present) return current;
    if (deepEqual(current.value, base.value)) return ABSENT;
    return recordConflict(
      context,
      "modify-delete",
      base,
      current,
      desired,
    );
  }
  if (deepEqual(current.value, desired.value)) return current;
  if (!base.present) return recordConflict(context, "add", base, current, desired);
  if (deepEqual(current.value, base.value)) return desired;
  if (deepEqual(desired.value, base.value)) return current;
  return recordConflict(context, "modify", base, current, desired);
}

/**
 * Three-way merge of the last applied value, the current live value, and a new
 * desired value. Fields changed on only one side are merged; incompatible
 * concurrent ownership is reported and, by default, the live value is kept.
 */
export function threeWayMerge<T = unknown>(
  base: unknown,
  current: T,
  desired: unknown,
  options: ThreeWayMergeOptions = {},
): MergeResult<T> {
  assertAcyclic(base, "base");
  assertAcyclic(current, "current");
  assertAcyclic(desired, "desired");

  const normalized = normalizeOptions(options);
  const context: MergeContext = {
    options: normalized,
    schemaPath: [],
    path: [],
    conflicts: [],
  };

  const mergedPresence = mergeValue(
    presence(base),
    presence(current),
    presence(desired),
    context,
  );
  const merged = (
    mergedPresence.present ? cloneValue(mergedPresence.value) : undefined
  ) as T;
  const patch: MergePatch = createPatch(current, merged);

  const conflicts = [...context.conflicts].sort((left, right) => {
    return (
      compareStrings(left.path, right.path) ||
      compareStrings(left.kind, right.kind) ||
      compareStrings(
        stableStringify(left.base),
        stableStringify(right.base),
      ) ||
      compareStrings(
        stableStringify(left.current),
        stableStringify(right.current),
      ) ||
      compareStrings(
        stableStringify(left.desired),
        stableStringify(right.desired),
      )
    );
  });

  return {
    merged,
    patch,
    conflicts,
    hasConflicts: conflicts.length > 0,
  };
}

export class ThreeWayMerger {
  readonly options: ThreeWayMergeOptions;

  constructor(options: ThreeWayMergeOptions = {}) {
    this.options = options;
  }

  merge<T = unknown>(
    base: unknown,
    current: T,
    desired: unknown,
  ): MergeResult<T> {
    return threeWayMerge(base, current, desired, this.options);
  }

  computePatch(
    base: unknown,
    current: unknown,
    desired: unknown,
  ): MergePatch {
    return this.merge(base, current, desired).patch;
  }
}

export function createMerger(
  options: ThreeWayMergeOptions = {},
): ThreeWayMerger {
  return new ThreeWayMerger(options);
}

export function computePatch(
  base: unknown,
  current: unknown,
  desired: unknown,
  options: ThreeWayMergeOptions = {},
): MergePatch {
  return threeWayMerge(base, current, desired, options).patch;
}

export const merge3 = threeWayMerge;
export const computeMerge = threeWayMerge;
export const merge = threeWayMerge;
