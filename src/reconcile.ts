import type { Key } from "./key";
import { buildPivot, type ColNode, type Pivot, type RowNode } from "./pivot";
import { PivotStore, type RecordState } from "./store";

export interface GroupMismatch {
  readonly leafId: string;
  readonly pivotSum?: bigint;
  readonly referenceSum?: bigint;
  readonly pivotCount?: number;
  readonly referenceCount?: number;
}

export interface CellMismatch {
  readonly rowPrefix: Key;
  readonly colPrefix: Key;
  readonly pivotSum: bigint;
  readonly referenceSum: bigint;
}

export interface ReconcileReport {
  readonly ok: boolean;
  readonly grandTotalPivot: bigint;
  readonly grandTotalReference: bigint;
  /** Groups present in the reference GROUP BY but missing from the pivot. */
  readonly missingInPivot: readonly string[];
  /** Pivot leaf groups with no backing records (e.g. left over after a
   *  cross-group migration): must always be empty. */
  readonly staleInPivot: readonly string[];
  readonly groupMismatches: readonly GroupMismatch[];
  readonly cellMismatches: readonly CellMismatch[];
}

function prefixMatches(key: Key, prefix: Key): boolean {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!Object.is(key[i], prefix[i])) return false;
  }
  return true;
}

/** Deliberately naive reference: filter the flat table, then sum. This is
 *  the "full-table GROUP BY" the pivot is checked against. */
function naiveSubtotal(records: readonly RecordState[], rowPrefix: Key, colPrefix: Key): bigint {
  let total = 0n;
  for (const record of records) {
    if (prefixMatches(record.row, rowPrefix) && prefixMatches(record.col, colPrefix)) {
      total += record.value;
    }
  }
  return total;
}

/**
 * Reconcile the pivot against an independent full-table GROUP BY:
 *
 * 1. leaf-level: every live (row, col) group must match the reference
 *    GROUP BY in sum and record count — catches dropped empty groups and
 *    stale groups left behind by cross-group migration;
 * 2. subtotal-level: every (row prefix, column prefix) cell of the tree is
 *    compared with a naive filter-and-sum over the flat table — catches
 *    double-counted leaf data in subtotals;
 * 3. grand total.
 */
export function reconcile(store: PivotStore, pivot: Pivot = buildPivot(store)): ReconcileReport {
  const records = store.effectiveRecords();

  // Reference GROUP BY over the flat table.
  const reference = new Map<string, { sum: bigint; count: number }>();
  for (const record of records) {
    const id = PivotStore.leafId(record.row, record.col);
    const prev = reference.get(id) ?? { sum: 0n, count: 0 };
    reference.set(id, { sum: prev.sum + record.value, count: prev.count + 1 });
  }

  const missingInPivot: string[] = [];
  const staleInPivot: string[] = [];
  const groupMismatches: GroupMismatch[] = [];

  const leaves = store.leaves();
  for (const [id, ref] of reference) {
    const leaf = leaves.get(id);
    if (!leaf) {
      missingInPivot.push(id);
    } else if (leaf.sum !== ref.sum || leaf.count !== ref.count) {
      groupMismatches.push({
        leafId: id,
        pivotSum: leaf.sum,
        referenceSum: ref.sum,
        pivotCount: leaf.count,
        referenceCount: ref.count,
      });
    }
  }
  for (const id of leaves.keys()) {
    if (!reference.has(id)) staleInPivot.push(id);
  }

  // Subtotal-level check: walk every cell of the tree.
  const cellMismatches: CellMismatch[] = [];
  const checkCol = (rowPrefix: Key, node: ColNode): void => {
    const expected = naiveSubtotal(records, rowPrefix, node.key);
    if (node.sum !== expected) {
      cellMismatches.push({
        rowPrefix,
        colPrefix: node.key,
        pivotSum: node.sum,
        referenceSum: expected,
      });
    }
    for (const child of node.children.values()) checkCol(rowPrefix, child);
  };
  const checkRow = (node: RowNode): void => {
    checkCol(node.key, node.colRoot);
    for (const child of node.children.values()) checkRow(child);
  };
  checkRow(pivot.root);

  const grandTotalReference = naiveSubtotal(records, [], []);
  const ok =
    missingInPivot.length === 0 &&
    staleInPivot.length === 0 &&
    groupMismatches.length === 0 &&
    cellMismatches.length === 0 &&
    pivot.grandTotal === grandTotalReference;

  return {
    ok,
    grandTotalPivot: pivot.grandTotal,
    grandTotalReference,
    missingInPivot,
    staleInPivot,
    groupMismatches,
    cellMismatches,
  };
}
