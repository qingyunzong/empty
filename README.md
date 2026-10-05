# unit-quantity

A dependency-free TypeScript library (Node.js built-ins only) that parses and
evaluates arithmetic expressions with physical units, using exact rational
arithmetic and integer dimension vectors.

## Usage

```ts
import { evaluateToString, evaluateExpression } from "./src/index.js";

evaluateToString("1 km + 1 m");      // "1001 m"
evaluateToString("10 m / 2 s");      // "5 m*s^-1"
evaluateToString("1 h + 30 min");    // "5400 s"
evaluateToString("0.1 m + 0.2 m");   // "3/10 m"   (exact, no floats)
evaluateToString("1 N * 1 m");       // "1 kg*m^2*s^-2"
```

## Rules

- **Numbers are exact rationals** (`Rational`, BigInt numerator/denominator);
  decimals like `0.1` parse to `1/10`, never to binary floating point.
- **Dimensions are integer vectors** over the 7 SI base dimensions
  (kg, m, s, A, K, mol, cd). `*`/`/` add/subtract the vectors, `^n` scales
  them, and `+`/`-` require identical vectors.
- **Zero is not exempt** from the dimension check: `0 m + 0 s` is a
  `UnitError`, exactly like `1 m + 1 s`.
- **Errors report subexpression ranges and canonical units**: `UnitError`
  carries `start`/`end` of the offending subexpression plus each side's
  range and canonical unit string (e.g. `kg*m*s^-2`).
- **Cross-checking**: `evaluateTyped` builds a small typed syntax tree and
  `recheck` independently recomputes every node from its children. The test
  suite also generates small syntax trees (exhaustive tiny trees + seeded
  random ones) and verifies that direct evaluation, a print/parse round
  trip, and typed-tree recomputation all agree, and that canonical unit
  strings re-parse to the same dimensions.

## Grammar

```
expr    := term (("+" | "-") term)*
term    := group (("*" | "/") group)*
group   := factor (implicit factor)*     // juxtaposition: "3 m", "N m"
factor  := "-" factor | power
power   := primary ("^" signed-integer)?
primary := NUMBER | UNIT | "(" expr ")"
```

Implicit multiplication binds looser than explicit `*`/`/`, so
`10 m / 2 s` means `(10 m) / (2 s)`.

Units: SI base units, `g`, `min`/`h`/`d`, `L`/`l`, the named derived SI
units (`N`, `J`, `W`, `Pa`, `Hz`, `V`, `ohm`/`Ω`, ...), and single SI
prefixes (`km`, `ms`, `mg`, `kPa`, ...).

## Scripts

- `npm run build` — compile with `tsc` to `dist/`
- `npm test` — build, then run the `node:test` suite (no install needed;
  `tsc` must be available)

Actual recorded test output: see `TEST-RESULTS.md`.
