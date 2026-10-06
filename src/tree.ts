/** A generated value together with its lazily-computed shrink candidates. */
export interface Tree<T> {
  readonly value: T;
  shrinks(): Iterable<Tree<T>>;
}

export function pure<T>(value: T): Tree<T> {
  return {
    value,
    *shrinks() {},
  };
}

export function mapTree<A, B>(tree: Tree<A>, f: (a: A) => B): Tree<B> {
  return {
    value: f(tree.value),
    *shrinks() {
      for (const child of tree.shrinks()) {
        yield mapTree(child, f);
      }
    },
  };
}
