# live-dom-query

A scoped DOM query engine in TypeScript with compiled reusable plans and live
incremental match diffs. Zero runtime dependencies.

## Selector language

```
selector-list := complex ("," complex)*        # comma union
complex       := compound (combinator compound)*
combinator    := whitespace+ | ">"             # descendant | child
compound      := (tag | "*")? attr*
attr          := "[" name ("=" (ident | quoted-string))? "]"
```

Examples: `div`, `[data-x=1]`, `div[data-x="1"][hidden]`, `ul > li`,
`div p span`, `a, b > c`.

Syntax errors are reported as `SelectorSyntaxError` with `start`/`end`
character offsets into the source string.

## Static queries

```ts
import { Document, compile, naiveQuery } from "./src/index.js";

const doc = new Document();            // root <html>
const div = doc.createElement("div", { "data-x": "1" });
doc.appendChild(doc.root, div);

const plan = compile("div[data-x=1] span");  // reusable plan
plan.query(doc.root);                        // document order, deduplicated
plan.matches(someNode, doc.root);            // single-node test
```

Semantics:

- Results are the matching nodes of the scope's subtree (the scope root
  itself is eligible), in document order, deduplicated across union branches.
- Ancestor traversal during matching stops at the scope root: a node inside
  the scope can never match through an ancestor outside it
  (`body span` scoped at an inner `div` matches nothing).
- `naiveQuery(scope, selector)` is an independent recursive reference
  implementation used to cross-check the compiled plan (see `test/plan.test.ts`).

## Live queries

```ts
const q = doc.watch("div[data-x=1] span", (diff, snapshot) => {
  diff.added;    // newly matched, document order
  diff.removed;  // newly unmatched, previous snapshot order
  diff.version;  // version of the resulting snapshot
}, { scope: doc.root, verify: true });

doc.setAttribute(div, "data-x", "1");  // queued into the current batch
doc.flush();                           // apply batch, emit diffs
q.snapshot;                            // immutable; old snapshots stay valid
q.dispose();
```

Model:

- Mutations (`appendChild`, `removeChild`, `setAttribute`, `removeAttribute`)
  apply to the tree immediately and are queued; live queries are updated in
  batches by `flush()`. A flush is also auto-scheduled on a microtask, so
  `await doc.whenIdle()` suffices for async use.
- Invalidation ranges include descendant-combinator effects: an attribute
  change on `N` re-evaluates `N`'s whole subtree (intersected with the scope);
  structural changes re-evaluate the inserted/removed subtrees.
- Mutations made from inside a diff callback are queued into the next batch
  of the same flush cycle, never the current one.
- Snapshots are frozen (`version` + `matches`); old snapshots are never
  mutated and can be retained.
- `verify: true` cross-checks every incremental update against a full
  re-match with the naive reference implementation.

## Development

```
npm test    # tsc build + node --test
```

Layout: `src/selector.ts` (parser + errors), `src/plan.ts` (compiler),
`src/naive.ts` (reference), `src/dom.ts` (tree + mutation queue),
`src/live.ts` (incremental engine), `test/` (unit + fuzz tests).
