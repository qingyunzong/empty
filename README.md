# canonical-codec

Canonical byte encoding for signed integers, byte strings, arrays and
objects, with a streaming parser and order-independent digests. TypeScript,
Node.js built-in modules only (`node:crypto`, `node:test`, `node:assert`),
zero runtime dependencies.

## Encoding format

All multi-byte numbers are big-endian. Every value starts with a 1-byte tag.

| Tag    | Type              | Payload                                             |
| ------ | ----------------- | --------------------------------------------------- |
| `0x01` | non-negative int  | `len:1` + minimal-length big-endian magnitude       |
| `0x02` | negative int `n`  | `len:1` + minimal-length big-endian magnitude of `-1 - n` |
| `0x03` | byte string       | `len:4` + raw bytes                                 |
| `0x04` | array             | `count:4` + encoded items                           |
| `0x05` | object            | `count:4` + key/value pairs                         |
| `0x06` | object key        | `len:4` + UTF-8 bytes (only valid inside an object) |

Canonicality rules (enforced by both encoder and parser):

- Integer magnitudes are minimal-length (no leading zero bytes).
- Object keys are sorted by raw UTF-8 byte order; duplicates are rejected.
- Keys must be valid UTF-8: overlong forms, surrogate code points
  (U+D800–U+DFFF) and values above U+10FFFF are rejected. The encoder
  additionally rejects JavaScript strings containing lone surrogates.
- Because key order is canonical, a value's digest does not depend on the
  insertion order of the input object.

## API

```ts
import { encode, encodePairs, StreamParser, digestHex } from "./src/index.js";

const bytes = encode({ b: [1, -2], a: new Uint8Array([9]) });
const hex = digestHex({ b: [1, -2], a: new Uint8Array([9]) });

const parser = new StreamParser((value) => console.log(value));
parser.push(chunk); // feed arbitrary chunks
parser.end();       // throws ParseError if a value is incomplete
```

- `encode(value)` / `encodePairs(entries)` — canonical bytes. Throws
  `EncodeError` on duplicate keys, lone surrogates, non-safe-integer
  numbers, or unsupported types. Integers may be `number` (safe integers)
  or `bigint` (arbitrary precision, up to 255 magnitude bytes).
- `StreamParser` — incremental decoder. `ParseError.offset` is the absolute
  byte offset in the stream where the error was detected. Decoded objects
  are returned as `Map` (insertion order = canonical key order); integers
  decode to `number` when safe, otherwise `bigint`.
- `digest(value, algorithm = "sha256")` / `digestHex(...)` — digest of the
  canonical encoding.

## Tests

```
npm test        # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
npm run typecheck
```

- `test/encode.test.ts` — byte-level vectors, key ordering, rejection of
  lone surrogates / duplicate keys / non-integers.
- `test/parse.test.ts` — round-trips, chunked streaming, and error-offset
  assertions for unknown tags, truncation, non-minimal integers, duplicate
  or out-of-order keys, and invalid UTF-8.
- `test/cross.test.ts` — an independent recursive encoder (separately
  implemented with `TextEncoder` and shift-based integer encoding) is
  cross-checked against the library on 300 seeded random values; digests
  are verified against `sha256` of the independent encoder's bytes and
  against reshuffled key insertion orders; the streaming parser decodes
  the independent encoder's output.

### Actual results (Node v22.22.1, TypeScript 7.0.2, 2026-10-05)

```
$ npm test
# tests 3        # test files
# pass 3
# fail 0
```

27 assertions-level tests in total, all passing:

- `test/encode.test.ts` — 9/9 ok
- `test/parse.test.ts` — 13/13 ok
- `test/cross.test.ts` — 5/5 ok
