# netdsl — cycle-explainable multilateral netting

Node.js 22, standard library only. A small DSL for netting rules, a static
type system, a bytecode compiler/VM, and a netting engine that minimises
settlement cash on a directed debt graph while explaining **every cancelled
cent** with the canonical cycle it came from.

## CLI

```sh
node net.js run rules.net obs.json --proof proof.json
```

Exit codes: `0` success, `1` rule/data error (stderr carries the error
code), `2` usage error.

## DSL

```
date 2026-10-02 {                  // trade-date scope; constants live and die here
  const floor = 1000;              // integer cents, no floats anywhere
  const fee   = 2.5%;              // percentage literal -> 250 basis points
  const cap   = 5000 USD;          // money literal

  filter ccy == USD and amount >= floor and id != #o9 and debtor != @M9;

  settle fee_due = min(abs(position) * fee, cap);
}
```

- Lexer tokens: members (`@M1`), currencies (`USD`), obligation ids (`#o9`),
  percentages (`2.5%`), dates, integers.
- Pratt parser: `or < and < comparison < +,- < * < unary not/-`, plus
  `min`/`max`/`abs`.
- Static types: `int`, `bps`, `bool`, `ccy`, `member`, `obid`, `date`,
  `money<ccy, gross|net>`. Mixing currencies is `E_CCY`; using a net
  position where a gross amount belongs (or vice versa) is `E_TYPE`;
  referencing `2026-10-01.cap` from another date's scope is `E_SCOPE`.
- Filters and settle expressions compile to stack-machine bytecode and run
  on a small VM (`src/bytecode.js`).

## Netting semantics

Per currency the engine builds a directed debt graph (parallel obligations
aggregated, obligation ids retained). A solution cancels simple directed
cycles at their bottleneck amount — this preserves every member's net
position exactly. The optimum minimises residual gross (= cash that must
move). **All** tied optima are enumerated, normalised (cycles sorted,
rotation-equivalent cycles collapsed to one canonical form) and emitted in
deterministic order. The proof attributes each cancelled amount to its
cycle, edge and originating obligation ids.

## Error codes

`E_PARSE` (syntax/data), `E_CCY` (currency mixing), `E_TYPE` (net/gross
confusion), `E_SCOPE` (cross-date constant), `E_CYCLE_DUP` (duplicate
canonical cycle in one solution), `E_NO_SOL` (nothing to settle).

## Tests

```sh
node --test
```

Includes a brute-force reference (`src/reference.js`) that cross-checks the
engine on random 30-obligation graphs: minimum cash, the full set of tied
optima, and net-position invariance. See `RESULTS.md`.
