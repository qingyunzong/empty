import type { LogicalTree, Predicate, Scalar } from './types.ts';

/** Split a predicate list into conjuncts (recursively through `and`). */
export function flattenAnd(preds: Predicate[]): Predicate[] {
  const out: Predicate[] = [];
  for (const pred of preds) {
    if (pred.kind === 'and') out.push(...flattenAnd(pred.preds));
    else out.push(pred);
  }
  return out;
}

export function columnsOf(scalar: Scalar): string[] {
  switch (scalar.kind) {
    case 'col':
      return [scalar.name];
    case 'lit':
    case 'param':
      return [];
    case 'fn':
      return scalar.args.flatMap(columnsOf);
  }
}

export function predicateColumns(pred: Predicate): string[] {
  if (pred.kind === 'and') return pred.preds.flatMap(predicateColumns);
  return [...columnsOf(pred.left), ...columnsOf(pred.right)];
}

/** All base relation names referenced by a logical tree. */
export function relationNames(tree: LogicalTree): Set<string> {
  const names = new Set<string>();
  const walk = (node: LogicalTree): void => {
    if (node.op.kind === 'Get') names.add(node.op.relation);
    node.children.forEach(walk);
  };
  walk(tree);
  return names;
}

/**
 * Resolves which base relation "owns" a column. Explicit ownership
 * (`columnOwners`) wins; otherwise the `relation_column` prefix convention is
 * used. Returns undefined when ownership cannot be determined.
 */
export type ColumnOwnerResolver = (column: string) => string | undefined;

export function createColumnOwnerResolver(
  columnOwners?: Record<string, string>,
): ColumnOwnerResolver {
  return (column: string): string | undefined => {
    const explicit = columnOwners?.[column];
    if (explicit !== undefined) return explicit;
    const underscore = column.indexOf('_');
    return underscore > 0 ? column.slice(0, underscore) : undefined;
  };
}

/** True when every column of a predicate is owned by one of `relations`. */
export function predicateBelongsTo(
  pred: Predicate,
  relations: Set<string>,
  ownerOf: ColumnOwnerResolver,
): boolean {
  return predicateColumns(pred).every((column) => {
    const owner = ownerOf(column);
    return owner !== undefined && relations.has(owner);
  });
}
