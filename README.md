# descparse

Descriptive binary-format parsing library for Node.js, written in TypeScript
with **zero runtime dependencies** (only Node.js built-ins and standard JS).

A binary structure is described declaratively in JSON; the library validates
the description, compiles it to an executable plan, and parses buffers with a
single cursor. A second, fully independent *direct interpreter* walks the raw
description without any compilation step, and the two implementations are
cross-checked against each other on randomly generated formats.

## Features

- **Length references** — a `bytes`/`string` field's length can reference a
  preceding integer field, with optional scale and offset:
  `{ "ref": "n", "scale": 4, "offset": 1 }` → `n * 4 + 1` bytes.
- **Conditional presence** — `when: { "ref": "tag", "eq": 1 }` (also
  `ne`/`lt`/`gt`); absent fields are simply omitted from the result.
- **Nested arrays** — array elements may themselves be arrays, structs, or
  references to named definitions; counts may come from a previous field.
- **Definition-graph cycle rejection** — named definitions that (transitively)
  contain themselves are rejected at validation time.
- **Multiplication overflow protection** — every length/count computation is
  checked against `Number.MAX_SAFE_INTEGER` and against `MAX_LENGTH` /
  `MAX_COUNT` limits; fixed-size arrays are pre-flighted against the
  remaining input before iterating.
- **Cursor restoration on error** — if parsing a struct fails, the cursor is
  restored to the offset where that struct began before the error propagates
  (so after a failed top-level `run`, `parser.offset` is back at the start).

## Format description

```jsonc
{
  "definitions": {                 // optional named structs
    "point": { "fields": [
      { "name": "x", "type": "uint16le" },
      { "name": "y", "type": "uint16le" }
    ] }
  },
  "root": {                        // inline struct or a definition name
    "fields": [
      { "name": "n",      "type": "uint8" },
      { "name": "data",   "type": "bytes", "length": { "ref": "n" } },
      { "name": "tag",    "type": "uint8" },
      { "name": "extra",  "type": "string", "length": 4,
        "when": { "ref": "tag", "eq": 1 } },
      { "name": "pts",    "type": "array", "count": { "ref": "n" },
        "element": { "type": "ref", "ref": "point" } },
      { "name": "matrix", "type": "array", "count": 2,
        "element": { "type": "array", "count": 2, "element": { "type": "uint8" } } }
    ]
  }
}
```

Field types: `uint8`, `uint16le`, `uint16be`, `uint32le`, `uint32be`,
`bytes` (fixed or referenced length), `string` (UTF-8), `array`
(`count` + `element`), `struct` (inline `fields`), `ref` (named definition).

Validation rejects: definition cycles, unknown/forward field references,
references to non-integer or conditional fields, duplicate field names, and
out-of-range constants.

## Library API

```ts
import { compileFormat, Parser, parseBuffer } from "./src/parser";
import { interpret } from "./src/interpreter";

const plan = compileFormat(format);          // validates + compiles
const parser = new Parser(bytes);            // bytes: Uint8Array
const value = parser.run(plan);              // throws ParseError on failure
console.log(parser.offset);                  // bytes consumed (restored on error)

const { value: v2, bytesRead } = interpret(format, bytes); // direct interpreter
```

## CLI

```sh
npm run build
node dist/src/cli.js --format examples/packet.fmt.json --input examples/packet.bin
```

Prints the parsed structure as JSON (`bytes` fields as `"hex:..."`).
Exit codes: `0` parsed, `1` parse error (message includes the failing
offset), `2` usage/format error.

## Testing

```sh
npm test
```

- `test/parser.test.ts` — 24 unit tests: length references, scaled lengths,
  conditionals, nested arrays, named definitions, cycle/forward-reference/
  duplicate rejection, overflow and limit guards, cursor restoration,
  truncation offsets.
- `test/differential.test.ts` — 300 random formats × (compiling parser vs
  direct interpreter vs generator's expected model), 100 truncated-input
  rounds (both must throw; parser cursor must restore to 0), 50
  trailing-bytes rounds (both must stop at the same offset).
- `test/cli.test.ts` — end-to-end CLI runs: JSON output, conditional
  omission, exit codes 0/1/2.

### Actual results (2026-10-05, Node v22.22.1, tsc 7.0.2)

```
$ npm test
cli.test.js:          # tests 5   # pass 5   # fail 0
differential.test.js: # tests 3   # pass 3   # fail 0
parser.test.js:       # tests 24  # pass 24  # fail 0
# tests 3   (files)
# pass 3
# fail 0
```

32/32 tests pass (24 unit + 3 differential + 5 CLI; the differential suites
cover 450 randomized rounds in total).

## Layout

```
src/format.ts       format types + validation (cycle rejection, ref checks)
src/parser.ts       plan compiler + cursor-based parser (overflow guards)
src/interpreter.ts  independent direct interpreter (differential reference)
src/random.ts       seeded random format/data generator for tests
src/cli.ts          reading CLI
test/               unit, differential, and CLI tests
examples/           sample format + binary
```

Note: the build uses the globally installed `tsc`; there are no npm
dependencies. `src/shims.d.ts` provides minimal ambient declarations so the
project type-checks without `@types/node` (the library itself only uses
standard `Uint8Array`/`DataView`/`TextDecoder`).
