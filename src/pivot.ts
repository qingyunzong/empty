import { encodePart, prefixes, type Key, type KeyPart } from "./key";
import type { PivotStore } from "./store";

/** One node of the column subtotal tree hanging under a row node. */
export interface ColNode {
  /** Column key prefix this node stands for ([] = all columns). */
  readonly key: Key;
  sum: bigint;
  count: number;
  readonly children: Map<string, ColNode>;
}

/** One node of the row tree. `colRoot` holds this row prefix's subtotal
 *  broken down by every column prefix; colRoot itself is the row subtotal. */
export interface RowNode {
  /** Row key prefix this node stands for ([] = grand total row). */
  readonly key: Key;
  readonly colRoot: ColNode;
  readonly children: Map<string, RowNode>;
}

export interface Pivot {
  readonly root: RowNode;
  readonly grandTotal: bigint;
  readonly grandCount: number;
}

function newColNode(key: Key): ColNode {
  return { key, sum: 0n, count: 0, children: new Map() };
}

function newRowNode(key: Key): RowNode {
  return { key, colRoot: newColNode([]), children: new Map() };
}

/**
 * Roll live leaf groups up into a two-dimensional row/column tree.
 *
 * Every leaf contributes its sum exactly once to each (row prefix, column
 * prefix) cell, so a subtotal is always the plain sum of the leaves beneath
 * it and summing children always reproduces the parent: no leaf is ever
 * counted twice.
 */
export function buildPivot(store: PivotStore): Pivot {
  const root = newRowNode([]);
  for (const leaf of store.leaves().values()) {
    for (const rowPrefix of prefixes(leaf.row)) {
      let rowNode = root;
      for (let depth = 1; depth <= rowPrefix.length; depth++) {
        const part = rowPrefix[depth - 1] as KeyPart;
        const id = encodePart(part);
        let child = rowNode.children.get(id);
        if (!child) {
          child = newRowNode(rowPrefix.slice(0, depth));
          rowNode.children.set(id, child);
        }
        rowNode = child;
      }
      for (const colPrefix of prefixes(leaf.col)) {
        let colNode = rowNode.colRoot;
        for (let depth = 1; depth <= colPrefix.length; depth++) {
          const part = colPrefix[depth - 1] as KeyPart;
          const id = encodePart(part);
          let child = colNode.children.get(id);
          if (!child) {
            child = newColNode(colPrefix.slice(0, depth));
            colNode.children.set(id, child);
          }
          colNode = child;
        }
        colNode.sum += leaf.sum;
        colNode.count += leaf.count;
      }
    }
  }
  return { root, grandTotal: root.colRoot.sum, grandCount: root.colRoot.count };
}

function renderPart(part: KeyPart): string {
  return part === null ? "NULL" : JSON.stringify(part);
}

function renderKey(key: Key): string {
  return `[${key.map(renderPart).join(" / ")}]`;
}

/** Render the pivot as an indented text tree (row levels, with each row
 *  node's column breakdown nested beneath), ending with the grand total. */
export function formatPivot(pivot: Pivot): string {
  const lines: string[] = [];
  const renderCol = (node: ColNode, indent: string): void => {
    if (node.key.length > 0) {
      lines.push(`${indent}col ${renderKey(node.key)}  sum=${node.sum}  n=${node.count}`);
    }
    const childIndent = node.key.length > 0 ? indent + "  " : indent;
    for (const child of node.children.values()) renderCol(child, childIndent);
  };
  const renderRow = (node: RowNode, indent: string): void => {
    lines.push(
      `${indent}row ${renderKey(node.key)}  sum=${node.colRoot.sum}  n=${node.colRoot.count}`,
    );
    renderCol(node.colRoot, indent + "  ");
    for (const child of node.children.values()) renderRow(child, indent + "  ");
  };
  for (const child of pivot.root.children.values()) renderRow(child, "");
  lines.push(`TOTAL  sum=${pivot.grandTotal}  n=${pivot.grandCount}`);
  return lines.join("\n");
}
