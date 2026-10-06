/**
 * Delta-based replication between tables plus full index-model verification.
 */

import { Table, Delta, IndexModel, Row, RowId } from './store.js';

/**
 * Copy the current contents of `source` into `target`, then forward every
 * committed delta. Returns an unsubscribe function that stops replication.
 */
export function replicate(source: Table, target: Table): () => void {
  target.transaction((tx) => {
    for (const [id, row] of source.entries()) {
      tx.insert(row, id);
    }
  });
  return source.subscribe((delta) => applyDelta(target, delta));
}

/** Apply a published delta to a target table, preserving row ids. */
export function applyDelta(target: Table, delta: Delta): void {
  if (delta.length === 0) return;
  target.transaction((tx) => {
    for (const change of delta) {
      if (change.type === 'insert') {
        tx.insert(change.after as Row, change.id);
      } else if (change.type === 'update') {
        tx.replace(change.id, change.after as Row);
      } else {
        tx.delete(change.id);
      }
    }
  });
}

export interface VerificationReport {
  ok: boolean;
  problems: string[];
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`);
  return `{${entries.join(',')}}`;
}

function canonicalRows(rows: Map<RowId, Row>): string {
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, row]) => `${id}=${canonicalize(row)}`)
    .join('|');
}

function canonicalModel(model: IndexModel): string {
  const parts: string[] = [];
  for (const [name, index] of [...model.unique.entries()].sort()) {
    const body = [...index.entries()]
      .map(([key, id]) => `${canonicalize(key)}->${id}`)
      .sort()
      .join(',');
    parts.push(`unique:${name}:{${body}}`);
  }
  for (const [name, index] of [...model.multi.entries()].sort()) {
    const body = [...index.entries()]
      .map(([key, ids]) => `${canonicalize(key)}->${[...ids].sort((a, b) => a - b).join('/')}`)
      .sort()
      .join(',');
    parts.push(`multi:${name}:{${body}}`);
  }
  return parts.join('|');
}

/**
 * Internal consistency check: rebuild every index from row data and compare
 * against the live index structures.
 */
export function verifyIndexModel(table: Table): VerificationReport {
  const problems: string[] = [];
  const rebuilt = canonicalModel(table.rebuildIndexModel());
  const live = canonicalModel(table.liveIndexModel());
  if (rebuilt !== live) {
    problems.push(
      `table "${table.name}": live index model diverges from rows\n  live:    ${live}\n  rebuilt: ${rebuilt}`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Full verification of a replica against its source: identical row sets and
 * identical rebuilt index models on both sides, plus internal consistency of
 * each table's live indexes.
 */
export function verifyReplica(source: Table, replica: Table): VerificationReport {
  const problems: string[] = [];

  for (const report of [verifyIndexModel(source), verifyIndexModel(replica)]) {
    problems.push(...report.problems);
  }

  const sourceRows = canonicalRows(source.rowSnapshot());
  const replicaRows = canonicalRows(replica.rowSnapshot());
  if (sourceRows !== replicaRows) {
    problems.push(
      `row sets diverge\n  source:  ${sourceRows}\n  replica: ${replicaRows}`,
    );
  }

  const sourceModel = canonicalModel(source.rebuildIndexModel());
  const replicaModel = canonicalModel(replica.rebuildIndexModel());
  if (sourceModel !== replicaModel) {
    problems.push(
      `index models diverge\n  source:  ${sourceModel}\n  replica: ${replicaModel}`,
    );
  }

  return { ok: problems.length === 0, problems };
}
