# sentence-splitter

Split a script into sentences on **top-level semicolons**. Semicolons inside
string literals, line comments, block comments and template literals
(including `${ ... }` interpolations with arbitrarily nested parens/braces)
do not split.

## API

```ts
import { split, Splitter, SplitError } from './src/splitter.ts';

split('a=1; `x${f(1;2)}y`; // c;d')
// => [{ text: 'a=1;', start: 0, end: 4 }, ...]
```

- Each `Sentence` keeps its original span: `text`, `start`, `end` (offsets
  into the source, `text === source.slice(start, end)`).
- `Splitter` is incremental: `write(chunk)` any number of times (even one
  character at a time), then `end()` returns the sentences. Chunked and
  whole-string parsing are verified to produce identical results.
- Unclosed structures (string, template, block comment, bracket) throw
  `SplitError` with `kind` and `position` of the earliest unclosed opening.
  Mismatched closing brackets throw `SplitError` with `kind: 'mismatch'`.

## Test

```sh
npm test
```
