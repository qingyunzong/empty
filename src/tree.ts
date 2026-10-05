/**
 * Lazy shrink tree. The root holds a generated value; children are
 * "smaller" candidates computed on demand so generation stays cheap.
 */
export interface Tree<T> {
  readonly value: T;
  children(): Iterable<Tree<T>>;
}

export function tree<T>(value: T, children: () => Iterable<Tree<T>>): Tree<T> {
  return { value, children };
}

export function mapTree<A, B>(t: Tree<A>, f: (a: A) => B): Tree<B> {
  return tree(f(t.value), function* () {
    for (const c of t.children()) yield mapTree(c, f);
  });
}

/**
 * Keep only the nodes satisfying `ok`. The root is assumed valid (the
 * generator produced it). Invalid descendants are never exposed as
 * candidates; instead their own children are lifted into their place, so
 * shrinking can walk *through* contract-violating values without ever
 * evaluating one. This is how shrinking preserves the input contract
 * while still reaching the true single-step minimum.
 */
export function filterTree<T>(t: Tree<T>, ok: (v: T) => boolean): Tree<T> {
  function* validChildren(node: Tree<T>): Iterable<Tree<T>> {
    for (const c of node.children()) {
      if (ok(c.value)) yield filterTree(c, ok);
      else yield* validChildren(c);
    }
  }
  return tree(t.value, () => validChildren(t));
}
