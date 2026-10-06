# config-editor

Span-preserving editor for simple `key = value` config files (TypeScript, zero dependencies).

## Model

- Comments start with `#` or `;` (full-line, or trailing after a value).
- Comment lines directly above an entry (no blank line between) are **attached**
  to that entry and move with it during `reorder`.
- Trailing comments (`key = value  # note`) do **not** belong to the entry;
  they stay in place when entries are reordered.
- Blank lines and unrecognized lines are kept verbatim and never move.

## Guarantees

- `set(key, value)` rewrites only the value's byte span; every other byte is
  preserved exactly. Unknown keys are appended as `key = value`.
- `reorder(order)` permutes entries together with their attached leading
  comments; `order` must be a permutation of all keys.
- Documents containing duplicate keys reject all edits (`set` / `reorder` throw).
- After every mutation the document is re-parsed and verified: key/value pairs
  must match the edit intent and no comment may be lost or altered.

## Usage

```ts
import { ConfigDocument } from './src/config-editor.js';

const doc = ConfigDocument.parse(text);
doc.get('host');              // read a value
doc.set('host', 'example.org');
doc.reorder(['port', 'host']);
const out = doc.toString();
```

## Test

```sh
npm test   # type-checks with tsc, compiles to dist/, runs node:test suite
```
