# replace-map

A TypeScript replacement engine (Node.js built-ins only, no dependencies) that
expands `$` references against non-overlapping matches with capture intervals
and produces a bidirectional mapping between the output and the source text.

## Features

- **Dollar-reference expansion** — `$$` (literal `$`), `$&` (whole match),
  `$1`..`$99` (capture groups, two digits preferred when valid). A reference
  to a non-existent group throws `InvalidReferenceError`; every template is
  validated before any output is produced, so the whole operation is
  rejected atomically (`src/template.ts`, `src/replace.ts`).
- **Zero-length matches** — `findMatches` advances the scan position by one
  full code point (surrogate-safe) after an empty match, so iteration always
  terminates (`src/match.ts`).
- **Output → source mapping** — copied runs (gaps, `$&`, captures) carry
  segments back to the input; inserted literal text has no source and maps
  to `null` (`src/sourcemap.ts`).
- **Inverse query returns all ranges** — a duplicated capture maps one
  source position to several output ranges; `inverse(pos)` returns every
  one of them, not a single position.
- **Composable rounds** — `SourceMap.compose` chains per-round maps into a
  map from the original text to the final text; text inserted in earlier
  rounds stays unmapped.
- **Sessions with rollback** — `ReplaceSession` binds a pre-image summary
  (round, length, SHA-256, preview) to each round and `rollback()` restores
  the pre-image (`src/session.ts`).
- **Budget** — `maxOutputLength` aborts the expansion with
  `BudgetExceededError`; failed rounds never modify the session.
- **Cross-checks** — a naive segment-by-segment interpreter
  (`src/reference.ts`) and a direct source-label propagation model
  (`src/tagged.ts`) serve as independent oracles in the tests.

## Usage

```ts
import { ReplaceSession, findMatches } from './src';

const session = new ReplaceSession('hello world');
const matches = findMatches(session.current, /(\w+)/g);
session.applyRound(matches, matches.map(() => '[$&]'));
session.current;              // '[hello] [world]'
session.composedMap()?.forward(1);   // 0  ('h' came from source 0)
session.composedMap()?.forward(0);   // null ('[' was inserted)
session.rollback();             // back to 'hello world'
```

## Test

```
npm test
```

## Recorded results (2026-10-05, Node v22.22.1, tsc 7.0.2)

`npm test` compiles with `tsc` and runs `node --test 'dist/test/*.test.js'`:

```
# tests 4
# pass 4
# fail 0
# duration_ms ~250
```

Per-file detail (`node --test-reporter=spec dist/test/<file>`), 17 tests, all
passing:

- `test/replace.test.js` (10): basic mapping, inserted content has no
  source, zero-length insertion, duplicated capture → one source many
  outputs, `$$`/`$&`/trailing `$`/literal `$x`/two-digit groups,
  non-participating capture → empty, invalid reference rejects the whole
  operation, budget aborts atomically, overlapping matches rejected,
  `findMatches` capture intervals, zero-length matches advance one code
  point (surrogate-safe).
- `test/sourcemap.test.js` (3): compose keeps inserted text unmapped,
  compose propagates capture duplication across rounds, identity round.
- `test/session.test.js` (3): per-round pre-image summary + rollback,
  composed map across rounds, failed rounds leave the session untouched.
- `test/random.test.js` (1): 60 seeds × 3 random replacement rounds —
  composed map `forward`/`inverse` verified for every position against
  direct source-label propagation, each round's output verified against
  the naive interpreter, and three rollbacks restore the original text.
