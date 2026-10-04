# posix-argv

Command construction library: builds POSIX argument display strings from
structured parameters, decodes them independently, and expands response
files — all without ever spawning a shell. TypeScript, Node.js built-ins
only (zero runtime dependencies).

## Layout

- `src/quote.ts` — `encode`/`encodeArg` (argv → display string) and
  `decode`/`decodeSpans` (display string → argv, with per-argument spans).
- `src/expand.ts` — response-file expansion over a virtual file system with
  per-byte provenance (`Segment`) and conditional branches.
- `src/edit.ts` — reverse editing: change an argument and propagate the
  change back into the original source files.

## Quoting rules

- NUL (`U+0000`) is rejected everywhere (encode, decode, response files).
- Non-empty arguments made of `[A-Za-z0-9_./:=+,-]` are emitted as-is.
  `@` is deliberately unsafe so a re-encoded token can never be mistaken
  for an include directive.
- Everything else (empty string, blanks, quotes, backslashes, newlines) is
  single-quoted with the classic `'\''` escape, so joining encoded
  arguments with a space can never change the argument count — verified
  exhaustively (see below).

## Response files

Directives are recognized only at token boundaries and are blank-terminated:

```
@path/to/file.rsp   splice another response file (recursive, cycle-checked)
@if(name) ... @else ... @endif    conditional branch on the condition set
@if(!name)                        negated condition
```

A literal `@` at a token boundary is written `'@'` or `\@`; `@` elsewhere in
a token is always literal. Expansion is pure byte substitution: every byte
of the display string carries its source (`file`, `start`, `end`), checked
by `assertProvenanceSound`-style tests over a virtual file graph (diamond
includes, conditional includes from different files, cross-file quoting
with `'\''`, `''` and embedded newlines).

## Reverse editing

`applyEdits(mainFile, vfs, conds, [{ index, value }])` maps each edited
argument back through the provenance to its source span, replaces the span
with the re-encoded value, and re-expands. Semantics:

- One edit to a shared source (e.g. a file included twice) updates every
  reference — global consistency falls out of source-level rewriting.
- A batch requiring the same source span to become two different texts is
  a conflict: the whole batch is rejected (`{ ok: false, conflicts }`),
  no file is touched.

## Testing

```
npm test        # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

Actual result (Node v22.22.1, TypeScript 7.0.2): **26/26 pass, 0 fail**
(~2.1 s):

- `test/quote.test.ts` — 7 tests. Includes exhaustive acceptance over the
  short charset `[a ' " \ <space> \n @]`: all 400 strings of length ≤ 3
  round-trip; all 400×400 pairs joined with a space decode to exactly the
  same two arguments (concatenation never changes the count); all 85³
  triples over `[' \ <space> x]` round-trip.
- `test/expand.test.ts` — 9 tests: virtual file graph with diamond
  includes, conditional branches (negated, nested, per-branch includes),
  cross-file quoting, literal `@` forms, cycle/missing-file/bad-directive/
  NUL errors.
- `test/edit.test.ts` — 10 tests: reverse edits through include chains,
  quote-needing values, argument-count preservation, shared-source global
  consistency, all-rejected conflicts, conditional-branch sources.
