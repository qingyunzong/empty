# config-edit

Whitespace- and comment-preserving editor for a YAML-subset configuration
format (block maps, block sequences, scalars, `#` comments). Written in
TypeScript, Node.js built-ins only (`node:test` / `node:assert` for tests;
no runtime dependencies).

## Model

`parse(src)` produces a tree in which every node records exact byte spans
(`range`, `valueRange`, `keyRange`). Edits are pure text splices over those
spans, so every byte that is not the edit target — indentation, blank lines,
inline and full-line comments — is preserved verbatim.

- `setByPath(doc, path, value)` — replaces **only the lexical span** of the
  scalar at `path` (an implicit null `key:` / `-` gains `" value"` after the
  indicator). A path that does not resolve is a no-op (`changed: false`,
  original text returned). Setting a container path throws.
- `deleteByPath(doc, path, )` — removes the item's whole lines. Its trailing
  comment lines (contiguous full-line comments at item indent or deeper) are
  **moved to just after the previous surviving sibling item**; with no
  previous sibling they stay in place. Comments separated by a blank line are
  not owned and never move. A missing path is a no-op. Deleting the last
  child leaves `key:` / `-`, which re-parses as `null`. Deleting the sole
  entry of an inline `- key: value` item blanks it to `-` (null item),
  keeping the line's inline comment; deleting the *first* inline entry of a
  multi-entry `- k: v` map throws (delete the whole item instead).

Both return `{ changed, text, edits }` where `edits` are the applied
`{ start, end, insert }` spans.

## Example

```ts
import { parse, setByPath, deleteByPath } from "./src/index.js";

const src = "a: 1  # keep\n# about b\nb: 2\nc: 3\n";
const after1 = setByPath(parse(src), ["a"], 42).text;
// => "a: 42  # keep\n# about b\nb: 2\nc: 3\n"
const after2 = deleteByPath(parse(after1), ["b"]).text;
// => "a: 42  # keep\n# about b\nc: 3\n"   (b's comment moved to a)
```

## Tests

`npm test` compiles with `tsc` and runs `node --test`:

- `test/edit.test.ts` — unit tests for span-exact set, comment-moving
  delete, missing-path no-ops, re-parse correctness.
- `test/fuzz.test.ts` — randomized edit verification: 40 seeded random
  documents (nested maps/seqs, inline `- k: v` maps, comments, blank lines),
  60 random set/delete/missing-path ops each. After every op it asserts:
  the text re-parses and the tree equals a plain-data model mutated in
  parallel; every full-line comment survives (verbatim, possibly relocated);
  unrelated scalar lexemes are byte-identical; set touches exactly one span
  (prefix/suffix unchanged); missing-path ops change nothing.

## Actual test results (recorded 2026-10-06, Node v22.22.1, tsc 7.0.2)

```
> npm test
# Subtest: dist/test/edit.test.js
ok 1 - dist/test/edit.test.js   (16 tests)
# Subtest: dist/test/fuzz.test.js
ok 2 - dist/test/fuzz.test.js
  fuzz stats: 40 docs, set=1110, delete=1067, missing=223, commentMoves=275, regens=229
# tests 2
# pass 2
# fail 0
```
