import type { CompiledProjection, TrieNode } from "./compile.ts";
import { ProjectionError } from "./errors.ts";
import { appendField, appendIndex, appendStar } from "./path.ts";

/** Marker for cells produced by missing fields or empty arrays. Never equal to null. */
export const MISSING: unique symbol = Symbol("dataeng-20261112-0060.missing");

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Cell {
  readonly value: JsonValue | typeof MISSING;
  /** Original JSON path of the cell, e.g. `items[0].id`; `[*]` marks placeholder branches. */
  readonly path: string;
}

export type ProjectionRow = Record<string, Cell>;

export interface ProjectOptions {
  /** Maximum rows a single record may yield; exceeding it rejects the record. */
  readonly maxRows?: number;
}

type Slot = readonly [columnIndex: number, cell: Cell];
type Fragment = Slot[];

interface Ctx {
  readonly maxRows: number;
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectRecord(
  compiled: CompiledProjection,
  record: JsonValue,
  options: ProjectOptions = {},
): ProjectionRow[] {
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  if (maxRows !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxRows) || maxRows < 0)) {
    throw new ProjectionError(
      "INVALID_OPTION",
      `maxRows must be a non-negative integer, got ${options.maxRows}`,
    );
  }
  const ctx: Ctx = { maxRows };
  const fragments = evalNode(compiled.root, record, "", ctx);
  if (fragments.length > maxRows) {
    throw new ProjectionError(
      "ROW_LIMIT_EXCEEDED",
      `projection yields ${fragments.length} rows, limit is ${maxRows}`,
    );
  }
  return fragments.map((fragment) => buildRow(compiled, fragment));
}

function evalNode(node: TrieNode, value: JsonValue, path: string, ctx: Ctx): Fragment[] {
  const parts: Fragment[][] = [];
  if (node.terminals.length > 0) {
    const cell: Cell = { value, path };
    const fragment: Fragment = node.terminals.map((index): Slot => [index, cell]);
    parts.push([fragment]);
  }
  if (node.array !== null) {
    parts.push(evalArray(node.array, value, path, ctx));
  }
  for (const [name, child] of node.fields) {
    parts.push(evalField(child, name, value, appendField(path, name), ctx));
  }
  return merge(parts, ctx);
}

function evalField(
  child: TrieNode,
  name: string,
  value: JsonValue,
  path: string,
  ctx: Ctx,
): Fragment[] {
  if (!isPlainObject(value)) {
    throw new ProjectionError(
      "TYPE_MISMATCH",
      `field step "${name}" requires an object at "${path}"`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, name)) {
    return evalNode(child, value[name], path, ctx);
  }
  return evalMissing(child, path);
}

function evalArray(child: TrieNode, value: JsonValue, path: string, ctx: Ctx): Fragment[] {
  if (!Array.isArray(value)) {
    throw new ProjectionError(
      "TYPE_MISMATCH",
      `array expansion requires an array at "${path === "" ? "<root>" : path}"`,
    );
  }
  if (value.length === 0) {
    return evalMissing(child, appendStar(path));
  }
  const rows: Fragment[] = [];
  for (let index = 0; index < value.length; index++) {
    for (const fragment of evalNode(child, value[index], appendIndex(path, index), ctx)) {
      rows.push(fragment);
    }
    if (rows.length > ctx.maxRows) {
      throw new ProjectionError(
        "ROW_LIMIT_EXCEEDED",
        `row limit ${ctx.maxRows} exceeded at "${path}"`,
      );
    }
  }
  return rows;
}

function evalMissing(node: TrieNode, path: string): Fragment[] {
  const fragment: Fragment = [];
  collectMissing(node, path, fragment);
  return [fragment];
}

function collectMissing(node: TrieNode, path: string, out: Slot[]): void {
  if (node.terminals.length > 0) {
    const cell: Cell = { value: MISSING, path };
    for (const index of node.terminals) out.push([index, cell]);
  }
  if (node.array !== null) collectMissing(node.array, appendStar(path), out);
  for (const [name, child] of node.fields) collectMissing(child, appendField(path, name), out);
}

function merge(parts: Fragment[][], ctx: Ctx): Fragment[] {
  let rows: Fragment[] = [[]];
  for (const part of parts) {
    const next: Fragment[] = [];
    for (const row of rows) {
      for (const fragment of part) {
        next.push([...row, ...fragment]);
        if (next.length > ctx.maxRows) {
          throw new ProjectionError(
            "ROW_LIMIT_EXCEEDED",
            `row limit ${ctx.maxRows} exceeded`,
          );
        }
      }
    }
    rows = next;
  }
  return rows;
}

function buildRow(compiled: CompiledProjection, fragment: Fragment): ProjectionRow {
  const cells: Cell[] = new Array(compiled.columns.length);
  for (const [index, cell] of fragment) cells[index] = cell;
  const row: ProjectionRow = {};
  for (let index = 0; index < compiled.columns.length; index++) {
    row[compiled.columns[index].name] = cells[index];
  }
  return row;
}
