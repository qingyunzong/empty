export function tree(value, children) {
    return { value, children };
}
export function mapTree(t, f) {
    return tree(f(t.value), function* () {
        for (const c of t.children())
            yield mapTree(c, f);
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
export function filterTree(t, ok) {
    function* validChildren(node) {
        for (const c of node.children()) {
            if (ok(c.value))
                yield filterTree(c, ok);
            else
                yield* validChildren(c);
        }
    }
    return tree(t.value, () => validChildren(t));
}
