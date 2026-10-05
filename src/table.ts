import type { Row } from './expr.js';

export type RowId = string | number;

export interface Table {
  readonly name: string;
  readonly rows: readonly Row[];
}

export function rowId(row: Row): RowId {
  return row.id as RowId;
}

export function createTable(name: string, rows: readonly Row[]): Table {
  if (!Array.isArray(rows) || !Number.isFinite(rows.length)) {
    throw new TypeError('table rows must be a finite array');
  }
  const seen = new Set<RowId>();
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`row ${index} must be a plain object`);
    }
    const id = row.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new TypeError(`row ${index} must have a string or number "id"`);
    }
    if (seen.has(id)) {
      throw new TypeError(`duplicate row id: ${String(id)}`);
    }
    seen.add(id);
    Object.freeze(row);
  });
  return Object.freeze({ name, rows: Object.freeze(rows.slice()) });
}
