# mail-template

Email template library in TypeScript using only Node.js built-in modules
(zero runtime/dev dependencies; `tsc` is the only build tool).

## Template syntax

```
{{ user.name }}                          variable (dotted path)
{% if vip %} ... {% else %} ... {% endif %}   conditional ("!" negates)
{% for u in users %} ... {% endfor %}    loop over an array
```

## Guarantees

- **No recursive re-interpretation** — substituted values are inserted
  literally; `{{` / `{%` inside a value is never re-parsed.
- **Per-character provenance** — `renderWithProvenance()` returns spans that
  tile the output; `originAt(i)` attributes each output character to a
  template source offset or to a variable (name, loop iteration, offset
  within the value).
- **Nesting errors carry source ranges** — `TemplateSyntaxError` exposes
  `start`/`end` offsets into the original template plus `excerpt()`.
- **Atomic length limit** — `maxOutputLength` makes rendering
  all-or-nothing: exceeding it throws `RenderLimitError` and no partial
  output is produced.
- **Cross-checked mapping** — `src/interpreter.ts` is a small independent
  reference interpreter; the test suite asserts it agrees with the
  provenance renderer and that every span/character maps back to its
  claimed source (fixed cases + 300 seeded fuzz iterations).

## API

```ts
import { render, renderWithProvenance, renderPlain } from './src/index.js';

render('Hi {{ name }}!', { name: 'Ada' });            // "Hi Ada!"
const r = renderWithProvenance(tpl, data, { maxOutputLength: 5000 });
r.text;        // rendered string
r.spans;       // ordered, non-overlapping provenance spans
r.originAt(0); // { kind: 'template', srcIndex: 0 } | { kind: 'variable', ... }
```

## Tests

```
npm test      # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

## Actual test results

Recorded 2026-10-05, Node.js v22.22.1, tsc 5.x, Linux x86_64:

```
# tests 12 (via dist/test/template.test.js)
# pass 12
# fail 0
# duration_ms ~400-1000
```

All 12 subtests pass: variables, non-recursive substitution, conditionals,
loops, type errors, provenance (2), originAt bounds, syntax error ranges,
atomic length limit, reference-interpreter agreement, and the 300-iteration
seeded fuzz cross-check.

## Layout

- `src/template.ts` — lexer/parser, AST with source spans, `TemplateSyntaxError`
- `src/render.ts` — provenance renderer, `RenderLimitError`, atomic limit
- `src/interpreter.ts` — small reference interpreter for cross-checking
- `test/template.test.ts` — `node:test` suite
- `types/node-shim.d.ts` — minimal ambient declarations for `node:test` /
  `node:assert/strict` (used instead of `@types/node` to stay dependency-free)
