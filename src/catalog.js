import fs from 'node:fs';
import path from 'node:path';

export const PAGE_SIZE = 100;
export const DEFAULT_SELECTIVITY = 0.1;
export const DEFAULT_DISTINCT = 10;
export const RANGE_SELECTIVITY = 0.25;

export function loadCatalog(dbDir) {
  const file = path.join(dbDir, 'catalog.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveCatalog(dbDir, catalog) {
  const file = path.join(dbDir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
}

export function tableStats(catalog, table) {
  const stats = catalog.tables?.[table];
  if (!stats) throw new Error(`unknown table: ${table}`);
  return stats;
}

export function columnStats(catalog, table, column) {
  const stats = tableStats(catalog, table);
  const col = stats.columns?.[column];
  if (!col) throw new Error(`unknown column: ${table}.${column}`);
  return col;
}

export function hasColumn(catalog, table, column) {
  return Boolean(catalog.tables?.[table]?.columns?.[column]);
}

export function pagesOf(rowCount) {
  return Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
}

export function selectivityOf(catalog, table, column) {
  const col = catalog.tables?.[table]?.columns?.[column];
  return col?.selectivity ?? DEFAULT_SELECTIVITY;
}

export function distinctOf(catalog, table, column) {
  const col = catalog.tables?.[table]?.columns?.[column];
  return col?.distinct ?? DEFAULT_DISTINCT;
}

export function hasIndex(catalog, table, column) {
  const stats = catalog.tables?.[table];
  return Boolean(stats?.indexes?.includes(column));
}

export function loadTableRows(dbDir, table) {
  const file = path.join(dbDir, 'data', `${table}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
