import { HeaderAssociationError } from './errors.js';
import type { Cell } from './types.js';

/**
 * Resolve a non-empty explicit `headers` list.
 *
 * The authored order is preserved while dependencies are expanded
 * depth-first. Only header cells that themselves have no further header
 * dependencies are kept. Every branch is walked so a cycle reachable through
 * any path is detected; leaf output is de-duplicated by first reach, which
 * gives deterministic ordering independent of reference count.
 *
 * A missing ID, a reference that lands on a data cell, or a dependency cycle
 * fails the entire table with a reproducible ID path rooted at `dataCell`.
 */
export function resolveExplicitPath(
  dataCell: Cell,
  byId: Map<string, Cell>,
): string[] {
  const onStack = new Set<string>();
  const emitted = new Set<string>();
  const leaves: string[] = [];

  const visit = (headerId: string, trail: string[]): void => {
    const target = byId.get(headerId);
    if (target === undefined) {
      throw new HeaderAssociationError(
        'MISSING_HEADER_ID',
        trail,
        `Header id "${headerId}" referenced at path [${trail.join(' -> ')}] does not exist`,
      );
    }
    if (target.role === 'data') {
      throw new HeaderAssociationError(
        'HEADER_REFERS_TO_DATA',
        trail,
        `Header reference at path [${trail.join(' -> ')}] points to data cell "${headerId}"`,
      );
    }
    if (onStack.has(headerId)) {
      throw new HeaderAssociationError(
        'CYCLIC_HEADER_DEPENDENCY',
        trail,
        `Cyclic header dependency detected at path [${trail.join(' -> ')}]`,
      );
    }

    if (target.headers.length === 0) {
      if (!emitted.has(headerId)) {
        emitted.add(headerId);
        leaves.push(headerId);
      }
      return;
    }

    onStack.add(headerId);
    for (const dependency of target.headers) {
      visit(dependency, [...trail, dependency]);
    }
    onStack.delete(headerId);
  };

  for (const headerId of dataCell.headers) {
    visit(headerId, [dataCell.id, headerId]);
  }

  return leaves;
}
