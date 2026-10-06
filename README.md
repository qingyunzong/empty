# export-linker

A fixed-point export linker for module graphs. For every module it merges
**explicit exports**, **star exports** (`export * from ...`) and **aliased
re-exports** (`export { a as b } from ...`) into one resolved export map,
reporting the source path of every exported name.

## Merge rules

- **Explicit priority** — explicit exports (local or aliased re-export)
  shadow any name arriving through star exports.
- **Ambiguity** — a name reaching a module through star exports from two
  *different* origin bindings is reported as `ambiguous-star-export` and is
  not exported.
- **Same binding, many paths** — the same origin binding arriving via
  multiple paths is *not* ambiguous; the shortest path wins.

## Fixed-point resolution

Cyclic module graphs are resolved by iterating full-graph merge rounds.
Each round recomputes every module's exports from the previous round (the
reference) and is verified against it; identical maps mean the fixed point
is reached. Name sets grow monotonically and origins are stable, so the
iteration always terminates. `link(modules, { trace: true })` returns
per-round snapshots for independent verification.

## Usage

```sh
npm test          # compile (tsc) and run the test suite
npm run build     # compile only
node dist/src/cli.js graph.json   # link a graph and print the report
```

`graph.json` is an array of modules:

```json
[
  { "path": "a.ts", "exports": [{ "exportedName": "foo" }] },
  { "path": "b.ts",
    "exports": [{ "exportedName": "baz", "source": "a.ts", "importedName": "foo" }],
    "starExports": ["a.ts"] }
]
```

Library API: `link(modules, options?)` (see `src/linker.ts`) returns
`{ exports, diagnostics, rounds, snapshots? }`; `formatReport(result)`
(see `src/format.ts`) renders the resolved exports with their source paths.

No runtime dependencies; the build relies on a globally available `tsc`.
