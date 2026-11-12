import { ProjectionError } from "./errors.ts";
import { parsePath } from "./path.ts";

export interface ColumnSpec {
  readonly name: string;
  readonly path: string;
}

export interface TrieNode {
  readonly terminals: number[];
  readonly fields: Map<string, TrieNode>;
  array: TrieNode | null;
}

export interface CompiledProjection {
  readonly columns: readonly ColumnSpec[];
  readonly root: TrieNode;
}

function newNode(): TrieNode {
  return { terminals: [], fields: new Map(), array: null };
}

/**
 * Compiles column paths into a shared step trie. Columns whose paths share a
 * prefix (including every array-expansion step) share trie nodes, so each
 * distinct array node is expanded exactly once per record.
 */
export function compileProjection(columns: readonly ColumnSpec[]): CompiledProjection {
  const names = new Set<string>();
  const root = newNode();
  const specs: ColumnSpec[] = [];
  columns.forEach((column, index) => {
    if (typeof column.name !== "string" || column.name.length === 0) {
      throw new ProjectionError("INVALID_COLUMN", `column #${index} has an empty name`);
    }
    if (names.has(column.name)) {
      throw new ProjectionError("DUPLICATE_COLUMN", `duplicate column name "${column.name}"`);
    }
    names.add(column.name);
    const steps = parsePath(column.path);
    let node = root;
    for (const step of steps) {
      if (step.kind === "field") {
        let child = node.fields.get(step.name);
        if (child === undefined) {
          child = newNode();
          node.fields.set(step.name, child);
        }
        node = child;
      } else {
        if (node.array === null) node.array = newNode();
        node = node.array;
      }
    }
    node.terminals.push(index);
    specs.push({ name: column.name, path: column.path });
  });
  return { columns: Object.freeze(specs), root };
}
