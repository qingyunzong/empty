import assert from 'node:assert/strict';
import { HeaderAssociationError } from '../index.js';
import type {
  AssociationErrorCode,
  Cell,
  CellRole,
  CellScope,
  Grid,
} from '../index.js';

let sequence = 0;

export function makeCell(
  id: string,
  role: CellRole,
  text: string,
  options: { scope?: CellScope; headers?: string[] } = {},
): Cell {
  sequence += 1;
  return {
    id,
    role,
    text,
    scope: options.scope ?? 'none',
    headers: options.headers ? [...options.headers] : [],
  };
}

/** Build a rectangular grid from cell IDs, repeating objects to emulate spans. */
export function makeGrid(options: { layout: string[][]; cells: Cell[] }): Grid {
  const { layout, cells } = options;
  const byId = new Map<string, Cell>();
  for (const cell of cells) byId.set(cell.id, cell);
  return layout.map((row) =>
    row.map((id) => {
      const cell = byId.get(id);
      if (!cell) throw new Error(`unknown cell id in layout: ${id}`);
      return cell;
    }),
  );
}

/** Snapshot only the serializable fields used for assertions. */
export function snapshot(results: {
  dataId: string;
  text: string;
  headerPath: string[];
}[]): unknown {
  return results.map((result) => ({
    dataId: result.dataId,
    text: result.text,
    headerPath: [...result.headerPath],
  }));
}

/** Run a failing association and assert its deterministic error code/path. */
export function expectAssociationError(
  fn: () => unknown,
  code: AssociationErrorCode,
  path: string[],
): void {
  try {
    fn();
  } catch (error: unknown) {
    const associationError = error as HeaderAssociationError;
    assert.ok(associationError instanceof HeaderAssociationError);
    assert.equal(associationError.code, code);
    assert.deepEqual([...associationError.path], path);
    return;
  }
  assert.fail(`expected HeaderAssociationError(${code})`);
}
