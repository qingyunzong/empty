# corp-actions

Corporate actions (dividends, splits, tenders) settlement DSL + compiler + VM,
for custody reconciliation. Node.js 22, standard library only.

## Usage

```sh
node bin/corp.js apply examples/actions.ca examples/lots.json --ledger
# or, once linked: corp apply actions.ca lots.json --ledger
```

`lots.json`:

```json
{
  "cash": 1000,
  "lots": [
    { "id": "L1", "security": "ACME", "quantity": 100, "acquired": "2024-01-15" }
  ]
}
```

## DSL

```
action <id>: <SEC> split <ratio-expr> ex <YYYY-MM-DD> v<n>
action <id>: <SEC> dividend <cash-expr> ex <date> v<n>
action <id>: <SEC> tender <cash-expr> for <ratio-expr> ex <date> v<n>
reverse <id> ex <date> v<n>
restated <id>: <SEC> <kind> ... ex <date> v<n>
sell <SEC> <ratio-expr> on <date>
```

- Expressions are constant-folded by a Pratt parser (`+ - * /`, parentheses,
  unary `-`). Ratio literals are plain numbers or fractions (`1/2`); cash
  literals carry a `$` (`$12.50`).
- Static types: every expression is `ratio` (shares / dimensionless) or
  `cash`. Mixing them additively, multiplying cash by cash, or dividing a
  ratio by cash is a static `E_RATIO` error. A split ratio must be in
  `(0, 1]` (old:new, so `split 1/2` doubles shares); a ratio `> 1` split is
  rejected statically.
- Scope is per security: an action only touches lots of its own security;
  multiple actions on the same security compose in order. Cash is a single
  shared settlement account.

## Semantics

- Actions take effect on their ex-date: only lots acquired **before** the
  ex-date are eligible. Events are ordered by `(ex-date, announcement
  version, content hash, source order)` — same ex-date and same version is
  tie-broken by the SHA-256 of the canonical action content.
- `reverse` never deletes history: it appends a reversing corporate action
  to the ledger. The inverse is computed from the recorded effect of the
  original announcement.
- Sold lots are traced FIFO. If a reversal must remove shares that were
  already sold, the shortfall is booked as a `payable` (shares or cash)
  instead of driving a position negative; tender buy-backs for lots no
  longer held are booked as `receivable`. Positions never go negative, so
  holdings and cash always reconcile against ledger + adjustments.
- `restated` only affects lots acquired **on/after** the original ex-date
  (i.e. the post-ex-date world); it may follow a withdrawal (`reverse`).
- `sell` delivers out FIFO by `(acquired, lot sequence)`; selling more than
  held is `E_LOT`.

## Bytecode & VM

`src/compile.js` lowers checked statements to a flat op stream
(`APPLY` / `REVERSE` / `RESTATE` / `SELL`). `src/vm.js` schedules ops as
events, executes them in canonical order, and maintains lots, cash, an
append-only ledger (with per-lot effect deltas and `cashAfter` for
reconciliation), and the adjustments (receivable/payable) list.

## Errors

| Code        | Raised for |
| ----------- | ---------- |
| `E_LOT`     | malformed lots input, overselling, unknown VM op |
| `E_RATIO`   | split ratio outside `(0,1]`, cash/share type mixing, bad version |
| `E_DATE`    | invalid calendar dates, reversal/restatement before the action ex-date |
| `E_REVERSE` | unknown/duplicate action id, double reverse, illegal restate |
| `E_SYNTAX`  | lexer/parser errors |

## Tests

```sh
node --test
```
