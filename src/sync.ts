/**
 * sync-import: three-way batch synchronization library.
 *
 * Model
 * -----
 * A snapshot is a list of items; each item has a unique `id` and a flat
 * record of primitive fields. Three snapshots are involved:
 *   - base:   the target baseline captured at the last successful sync
 *   - source: the incoming import batch
 *   - target: the current state of the target store
 *
 * Rules
 * -----
 * 1. If `target` deep-equals `base`, the batch applies wholesale
 *    (`batchStatus: "applied"`); the result is exactly `source`.
 * 2. If `target` has changed in any way, the WHOLE batch conflicts. Nothing
 *    is applied and there is no per-item partial overwrite
 *    (`batchStatus: "conflict"`, `result: null`).
 * 3. The caller may explicitly opt into a field-level three-way merge via
 *    `options.merge: true`. Fields that only one side changed merge
 *    automatically; genuinely conflicting fields (both sides changed the
 *    same field to different values, or delete-vs-modify on an item) require
 *    explicit directives. If every conflict is resolved by a directive the
 *    batch is `merged`; otherwise it stays `conflict` and `result` is null.
 *
 * The report always lists per-item resolutions and every unresolved
 * conflict, so a caller can see exactly what blocked the batch.
 */

export type FieldValue = string | number | boolean | null;

export interface Item {
  id: string;
  fields: Record<string, FieldValue>;
}

/** `undefined` for base/source/target means the field is absent there. */
export interface FieldConflict {
  itemId: string;
  field: string;
  base: FieldValue | undefined;
  source: FieldValue | undefined;
  target: FieldValue | undefined;
}

/** Item-level conflict: one side deleted the item while the other modified it. */
export interface ItemConflict {
  itemId: string;
  kind: 'delete-vs-modify';
  deletedBy: 'source' | 'target';
}

/** Explicit resolution for one conflicting field. */
export type FieldResolution =
  | { pick: 'source' | 'target' | 'base' }
  | { value: FieldValue };

export interface MergeDirectives {
  /** itemId -> field -> explicit resolution */
  fields?: Record<string, Record<string, FieldResolution>>;
  /** itemId -> which side to keep for delete-vs-modify item conflicts */
  items?: Record<string, 'source' | 'target'>;
}

export interface SyncOptions {
  /** Explicitly enable field-level three-way merge when the target changed. */
  merge?: boolean;
  directives?: MergeDirectives;
}

export type FieldOrigin = 'source' | 'target' | 'base' | 'both' | 'resolved';

export interface FieldDecision {
  field: string;
  origin: FieldOrigin;
  /** `undefined` means the field is absent in the decided outcome. */
  value: FieldValue | undefined;
}

export type ItemAction =
  | 'added'
  | 'removed'
  | 'updated'
  | 'unchanged'
  | 'merged'
  | 'conflict';

export interface ItemResolution {
  id: string;
  action: ItemAction;
  /** Per-field outcome for fields that differ across the three snapshots. */
  fields: FieldDecision[];
  conflicts: FieldConflict[];
  itemConflict: ItemConflict | null;
}

export type BatchStatus = 'applied' | 'conflict' | 'merged';

export interface SyncReport {
  batchStatus: BatchStatus;
  /** True when the target store diverged from the baseline. */
  targetChanged: boolean;
  items: ItemResolution[];
  /** Field-level conflicts with no explicit directive (empty unless merge is on). */
  unresolved: FieldConflict[];
  /** Item-level conflicts with no explicit directive (empty unless merge is on). */
  unresolvedItems: ItemConflict[];
  /** Resulting snapshot, or null when the batch did not apply. */
  result: Item[] | null;
}

type FieldMap = Map<string, FieldValue>;
type SnapshotMap = Map<string, FieldMap>;

function valueEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Object.is(a, b);
}

function fieldsEqual(a: FieldMap, b: FieldMap): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !valueEqual(b.get(key), value)) return false;
  }
  return true;
}

function snapshotsEqual(a: SnapshotMap, b: SnapshotMap): boolean {
  if (a.size !== b.size) return false;
  for (const [id, fields] of a) {
    const other = b.get(id);
    if (!other || !fieldsEqual(fields, other)) return false;
  }
  return true;
}

function normalize(items: readonly Item[], label: string): SnapshotMap {
  const map: SnapshotMap = new Map();
  for (const item of items) {
    if (map.has(item.id)) {
      throw new Error(`duplicate item id "${item.id}" in ${label} snapshot`);
    }
    map.set(item.id, new Map(Object.entries(item.fields)));
  }
  return map;
}

function toItems(map: SnapshotMap, order: readonly string[]): Item[] {
  const out: Item[] = [];
  for (const id of order) {
    const fields = map.get(id);
    if (fields) out.push({ id, fields: Object.fromEntries(fields) });
  }
  return out;
}

function unionIds(...maps: SnapshotMap[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const map of maps) {
    for (const id of map.keys()) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function unionKeys(...maps: (FieldMap | undefined)[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const map of maps) {
    if (!map) continue;
    for (const key of map.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

const EMPTY: FieldMap = new Map();

function get(map: FieldMap | undefined, key: string): FieldValue | undefined {
  return map?.get(key);
}

/** Fast path: target untouched, so the source batch applies wholesale. */
function appliedReport(base: SnapshotMap, source: SnapshotMap, sourceOrder: readonly string[]): SyncReport {
  const items: ItemResolution[] = [];
  for (const id of unionIds(base, source)) {
    const inBase = base.get(id);
    const inSource = source.get(id);
    let action: ItemAction;
    const decisions: FieldDecision[] = [];
    if (inBase && !inSource) {
      action = 'removed';
    } else if (!inBase && inSource) {
      action = 'added';
      for (const key of inSource.keys()) {
        decisions.push({ field: key, origin: 'source', value: inSource.get(key) });
      }
    } else if (inBase && inSource && !fieldsEqual(inBase, inSource)) {
      action = 'updated';
      for (const key of unionKeys(inBase, inSource)) {
        const b = inBase.get(key);
        const s = inSource.get(key);
        if (!valueEqual(b, s)) {
          decisions.push({ field: key, origin: 'source', value: s });
        }
      }
    } else {
      action = 'unchanged';
    }
    items.push({ id, action, fields: decisions, conflicts: [], itemConflict: null });
  }
  return {
    batchStatus: 'applied',
    targetChanged: false,
    items,
    unresolved: [],
    unresolvedItems: [],
    result: toItems(source, sourceOrder),
  };
}

interface ItemAnalysis {
  resolution: ItemResolution;
  /** Merged fields when the item is fully decided, null when it is removed. */
  merged: FieldMap | null;
  decided: boolean;
}

/**
 * Three-way analysis of one item id. Always computes diagnostics; only
 * consults directives when `mergeEnabled` is set.
 */
function analyzeItem(
  id: string,
  base: SnapshotMap,
  source: SnapshotMap,
  target: SnapshotMap,
  mergeEnabled: boolean,
  directives: MergeDirectives,
): ItemAnalysis {
  const inBase = base.has(id);
  const inSource = source.has(id);
  const inTarget = target.has(id);
  const baseFields = base.get(id);
  const sourceFields = source.get(id);
  const targetFields = target.get(id);

  const conflicts: FieldConflict[] = [];
  const decisions: FieldDecision[] = [];
  let itemConflict: ItemConflict | null = null;

  // Presence three-way.
  let present: boolean;
  if (inSource === inBase) present = inTarget;
  else if (inTarget === inBase) present = inSource;
  else present = inSource; // both flipped the same way

  // Delete-vs-modify: one side deleted while the other changed the fields.
  if (inBase && !inSource && inTarget && !fieldsEqual(baseFields ?? EMPTY, targetFields ?? EMPTY)) {
    itemConflict = { itemId: id, kind: 'delete-vs-modify', deletedBy: 'source' };
  } else if (inBase && inSource && !inTarget && !fieldsEqual(baseFields ?? EMPTY, sourceFields ?? EMPTY)) {
    itemConflict = { itemId: id, kind: 'delete-vs-modify', deletedBy: 'target' };
  }

  if (itemConflict && mergeEnabled) {
    const pick = directives.items?.[id];
    if (pick === 'source') {
      itemConflict = null;
      present = inSource;
      const merged = present ? new Map(sourceFields) : null;
      return {
        resolution: { id, action: present ? 'merged' : 'removed', fields: [], conflicts, itemConflict: null },
        merged,
        decided: true,
      };
    }
    if (pick === 'target') {
      itemConflict = null;
      present = inTarget;
      const merged = present ? new Map(targetFields) : null;
      return {
        resolution: { id, action: present ? 'merged' : 'removed', fields: [], conflicts, itemConflict: null },
        merged,
        decided: true,
      };
    }
  }

  const merged: FieldMap = new Map();
  let decided = itemConflict === null;

  if (present) {
    for (const key of unionKeys(baseFields, sourceFields, targetFields)) {
      const b = get(baseFields, key);
      const s = get(sourceFields, key);
      const t = get(targetFields, key);
      if (valueEqual(s, b) && valueEqual(t, b)) {
        merged.set(key, b as FieldValue);
        continue; // untouched everywhere
      }
      if (valueEqual(s, b)) {
        decisions.push({ field: key, origin: 'target', value: t });
        if (t !== undefined) merged.set(key, t);
        continue;
      }
      if (valueEqual(t, b)) {
        decisions.push({ field: key, origin: 'source', value: s });
        if (s !== undefined) merged.set(key, s);
        continue;
      }
      if (valueEqual(s, t)) {
        decisions.push({ field: key, origin: 'both', value: s });
        if (s !== undefined) merged.set(key, s);
        continue;
      }
      // Genuine conflict: both sides changed the field differently.
      const conflict: FieldConflict = { itemId: id, field: key, base: b, source: s, target: t };
      if (mergeEnabled) {
        const directive = directives.fields?.[id]?.[key];
        if (directive) {
          const value =
            'value' in directive ? directive.value
            : directive.pick === 'source' ? s
            : directive.pick === 'target' ? t
            : b;
          decisions.push({ field: key, origin: 'resolved', value });
          if (value !== undefined) merged.set(key, value);
          continue;
        }
      }
      conflicts.push(conflict);
      decided = false;
    }
  }

  let action: ItemAction;
  if (!decided) {
    action = 'conflict';
  } else if (!present && inBase) {
    action = 'removed';
  } else if (present && !inBase) {
    action = 'added';
  } else if (present && fieldsEqual(merged, baseFields ?? EMPTY)) {
    action = 'unchanged';
  } else {
    action = 'merged';
  }

  return {
    resolution: { id, action, fields: decisions, conflicts, itemConflict },
    merged: present ? merged : null,
    decided,
  };
}

export function syncBatch(
  baseItems: readonly Item[],
  sourceItems: readonly Item[],
  targetItems: readonly Item[],
  options: SyncOptions = {},
): SyncReport {
  const base = normalize(baseItems, 'base');
  const source = normalize(sourceItems, 'source');
  const target = normalize(targetItems, 'target');
  const sourceOrder = sourceItems.map((item) => item.id);

  if (snapshotsEqual(base, target)) {
    return appliedReport(base, source, sourceOrder);
  }

  const mergeEnabled = options.merge === true;
  const directives = options.directives ?? {};
  const analyses: ItemAnalysis[] = [];
  for (const id of unionIds(base, source, target)) {
    analyses.push(analyzeItem(id, base, source, target, mergeEnabled, directives));
  }

  const items = analyses.map((a) => a.resolution);
  const unresolved = items.flatMap((item) => item.conflicts);
  const unresolvedItems = items
    .map((item) => item.itemConflict)
    .filter((c): c is ItemConflict => c !== null);

  const canMerge = mergeEnabled && unresolved.length === 0 && unresolvedItems.length === 0;
  if (!canMerge) {
    return {
      batchStatus: 'conflict',
      targetChanged: true,
      items,
      unresolved,
      unresolvedItems,
      result: null,
    };
  }

  const mergedMap: SnapshotMap = new Map();
  const order: string[] = [];
  for (const analysis of analyses) {
    if (analysis.merged !== null) {
      mergedMap.set(analysis.resolution.id, analysis.merged);
      order.push(analysis.resolution.id);
    }
  }
  return {
    batchStatus: 'merged',
    targetChanged: true,
    items,
    unresolved: [],
    unresolvedItems: [],
    result: toItems(mergedMap, order),
  };
}
