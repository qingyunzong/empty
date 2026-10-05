/** Ranked trees and their prefix (Polish-notation) serialisation as sequences. */

export interface Tree {
  readonly symbol: string;
  readonly children: readonly Tree[];
}

/** Convenience constructor: tree("f", tree("a"), tree("b")). */
export function tree(symbol: string, ...children: readonly Tree[]): Tree {
  return { symbol, children };
}

export class SequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequenceError";
  }
}

/**
 * Decodes a prefix-notation token sequence into a ranked tree.
 * The sequence must contain exactly one tree: unknown symbols, truncation
 * and trailing tokens are all rejected with a SequenceError.
 */
export function decodeSequence(
  sequence: readonly string[],
  arity: Readonly<Record<string, number>>,
): Tree {
  let pos = 0;
  const parseNode = (): Tree => {
    if (pos >= sequence.length) {
      throw new SequenceError(`unexpected end of sequence at position ${pos}`);
    }
    const symbol = sequence[pos];
    pos += 1;
    const ar = arity[symbol];
    if (ar === undefined) {
      throw new SequenceError(`unknown symbol ${JSON.stringify(symbol)} at position ${pos - 1}`);
    }
    const children: Tree[] = [];
    for (let i = 0; i < ar; i += 1) children.push(parseNode());
    return { symbol, children };
  };
  const root = parseNode();
  if (pos !== sequence.length) {
    throw new SequenceError(
      `trailing ${sequence.length - pos} token(s) after a complete tree (position ${pos})`,
    );
  }
  return root;
}

/** Serialises a tree into prefix-notation token sequence (inverse of decodeSequence). */
export function encodeSequence(root: Tree): string[] {
  const out: string[] = [];
  const walk = (node: Tree): void => {
    out.push(node.symbol);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

export function treeSize(root: Tree): number {
  let size = 0;
  const walk = (node: Tree): void => {
    size += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return size;
}
