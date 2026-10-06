# live-dom-query

A scoped DOM selector engine in TypeScript with compiled reusable plans,
a naive recursive reference oracle, and live incremental match diffs over
a mutable element tree.

## Selector language

```
selector  := complex (',' complex)*          -- comma union
complex   := compound (('>' | WS) compound)* -- child / descendant combinators
compound  := (tag | '*')? ('[' name '=' value ']')*
value     := '"..."' | "'...'" | bare-token
```

- Results are deduplicated and returned in document order.
- Queries are scoped: ancestor walks for `>` and descendant combinators
  stop at the scope root and never match through elements outside it.
- Parse failures throw `SelectorSyntaxError` with a half-open character
  range `[start, end)` into the input string.

## API

```ts
import { ElementNode, Engine, compile, query, LiveQuery } from './src/index.js';

// One-shot or reusable compiled plans
const plan = compile('div[data-x="1"] > span, p');
plan.query(root);            // ElementNode[], document order
plan.matches(node, root);    // boolean predicate

// Mutable tree with batched, observable mutations
const engine = new Engine();
engine.appendChild(parent, child);
engine.setAttribute(node, 'data-x', '1');
engine.flush();              // or await engine.settled() (microtask async)

// Live queries: incremental diffs + immutable snapshot history
const live = new LiveQuery(engine, root, plan);
live.snapshot();             // current immutable Snapshot { version, nodes }
live.history();              // all snapshots ever produced, never mutated
live.onDiff(({ added, removed, snapshot }) => { /* ... */ });
live.verify();               // full-match check against the naive reference
```

Semantics of the live engine:

- An attribute change dirties the node's whole subtree, so invalidation
  always covers descendant-combinator effects.
- Mutations issued from inside a diff listener are queued and delivered
  as the next batch, never merged into the one currently notifying.
- `verify()` recomputes the full match set with the naive recursive
  reference implementation (`src/reference.ts`) and throws on divergence.

## Layout

- `src/dom.ts` — element tree + mutation batching engine
- `src/parser.ts` — selector parser with character-range errors
- `src/plan.ts` — compiled reusable plans (right-to-left matching)
- `src/reference.ts` — naive recursive reference implementation
- `src/live.ts` — live queries: diffs, snapshots, verification
- `test/` — node:test suites, including randomized plan-vs-reference
  and incremental-vs-reference cross-checks

## Scripts

- `npm test` — type-check, compile to `dist/`, run all tests
- `npm run typecheck` — strict type-check only
