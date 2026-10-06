# argmerge

Layered argument library in TypeScript. Merges three layers — schema defaults,
a config object, and CLI argv — into final values with per-option source
tracking and position-aware errors.

## Merge semantics

- Layers are ordered `default < config < cli`.
- **Scalar** options: the highest layer that sets the option wins; within one
  layer the last occurrence wins (`--mode a --mode b` → `b`).
- **List** options: occurrences accumulate within one layer
  (`--tag x --tag y` → `["x", "y"]`); a higher layer replaces the lower
  layer's list entirely (no cross-layer concatenation).
- `--` terminates option parsing; the remaining tokens (and bare tokens) are
  returned as `positionals`.
- **Mutex groups** are validated against the final merged values: a conflict
  is reported only when two or more group members are explicitly set
  (source `config` or `cli`); values coming from defaults never conflict.

## API

```ts
import { parse, ArgsError, formatLocation } from "argmerge";

const result = parse(schema, configObject, process.argv.slice(2));
result.values;      // final merged values
result.sources;     // per-option origin: { source: "default" | "config" | "cli", location }
result.positionals; // bare tokens and everything after `--`
```

`Location` pinpoints where a value or error came from: `argv[index]` plus the
token for CLI, the key for config, or the schema default. `ArgsError` carries
`location` for single-argument errors and `conflicts` (every option with its
origin) for mutex violations. Use `formatLocation` to render them.

## Test

```sh
npm test   # tsc + node --test, table-driven combination cases in test/args.test.ts
```
