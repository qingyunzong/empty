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
export type FieldResolution = {
    pick: 'source' | 'target' | 'base';
} | {
    value: FieldValue;
};
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
export type ItemAction = 'added' | 'removed' | 'updated' | 'unchanged' | 'merged' | 'conflict';
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
export declare function syncBatch(baseItems: readonly Item[], sourceItems: readonly Item[], targetItems: readonly Item[], options?: SyncOptions): SyncReport;
