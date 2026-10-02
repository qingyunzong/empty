# recon — end-of-day reconciliation CLI

Node.js 22, standard library only. Tests: `node --test`.

## Usage

```
node recon.js --dir <dir> --out <result.json> --explain <plan.txt> [--no-index]
```

Reads `internal.csv`, `bank.csv`, `fee.csv` from `<dir>`:

- `internal.csv` / `bank.csv`: `settle_date,account,serial_no,amount,currency`
- `fee.csv`: `settle_date,account,serial_no,fee,currency`
- Amounts: decimal (max 2 fraction digits) or `NULL`/empty for SQL NULL.

## Output (`result.json`)

- `matched` — semijoin `internal ⋈ bank` on key `(settle_date, account,
  serial_no)` where amounts are equal; NULL never equals anything (not even
  NULL).
- `onlyInternal` / `onlyBank` — key-set differences `internal − bank` and
  `bank − internal`.
- `feeDiff` — differences on the key intersection: `kind: "amount"` for
  amount/currency mismatches, `kind: "fee"` where the fee in `fee.csv`
  differs from the expected fee (10 bps of the internal amount). Any NULL
  involvement sets `isNull: true` and `diff: null`.
- `summary.byCurrency` — diff aggregation grouped by currency; `sum`/`avg`
  computed over non-NULL diffs only (AVG ignores NULL).

All arrays are sorted by key, so results are independent of input order,
join order, and index strategy.

## Query optimization

- Default: hash index built on the smaller relation, probed with the larger
  one (O(N+M)); `--no-index` falls back to a nested-loop join (O(N·M)).
- `--explain plan.txt` records the chosen strategy, join order, and the
  rationale (build-side memory vs probe cost).

## Errors

Exit code != 0, stderr is a single JSON line `{"code","message"}`:

- `E_SCHEMA` (exit 1) — bad/missing header, wrong field count, invalid
  date/amount, unreadable or missing file.
- `E_AMBIGUOUS` (exit 1) — duplicate key within one file.
- `E_USAGE` (exit 2) — bad CLI arguments.

## Layout

- `recon.js` — CLI entry; `src/cli.js` — args + CSV schema validation;
  `src/csv.js` — CSV parser; `src/engine.js` — relational core
  (semijoin/difference, hash index, aggregation, explain plan).
- `scripts/brute.js` — independent brute-force reference (acceptance C).
- `test/recon.test.js` — acceptance tests A–D. See `RESULTS.md`.
