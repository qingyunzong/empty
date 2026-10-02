# rev — payment revocation DSL / bytecode VM / WAL recovery

Rollback posted transactions with a revocation script (`.rvx`): cross-day locked
entries are compensated (never physically deleted), PENDING can only be marked
`CANCEL_REQUESTED` (never faked as success, never treated as failure), every
bytecode instruction is WAL-logged before execution, and `rev recover` replays
to the exact no-crash reference state. Re-execution is idempotent.
Node.js 22 standard library only; tests use `node:test`.

## CLI

```bash
rev run plan.rvx ledger.json --wal wal.log [--out out.json]
rev recover --wal wal.log [--out out.json]
```

- `run`: compile and execute the plan; the resulting ledger goes to `--out`
  (default `<ledger>.out.json`); a JSON report (counts/balances) goes to stdout.
- `recover`: read the WAL header to locate plan/ledger, replay all effect
  records; if the WAL has no `done` record, resume the same plan in append
  mode until done (idempotent: already-applied effects are skipped).
- Exit codes: `0` ok; `1` runtime error (E_STATE/E_LOCK/E_DUP/E_IO);
  `2` compile error (E_PARSE/E_TYPE/E_SCOPE); `3` injected crash (test hook
  `REV_CRASH_AFTER_SEQ=<n>` crashes right after WAL record n is fsynced).

## DSL

```
param rev_id = "rev-2026-0001";        # global params (top level, const expr)
param limit = 100.00;

for tx in txns(txn:1001, txn:1002) {   # or txns(*) for the whole ledger
  let big = tx.amount > limit;         # per-txn local (reset each iteration)
  when tx.status == SETTLED and big {  # Pratt-parsed condition expression
    revoke tx;
  }
}
```

- Lexer: `txn:<id>`, `acct:<name>`, amount literals (`12.50`, integer cents
  internally), status keywords `SETTLED/PENDING/LOCKED/CANCEL_REQUESTED/
  REVERSED/COMPENSATED`, strings, `#` comments.
- Precedence (Pratt): `or` < `and` < `==/!=` < comparisons < `+/-` < `*` `/`
  < unary `not`/`-`; parentheses and field access
  `tx.status|amount|account|day|id`.
- Scopes: `param` is global; the loop variable is a loop temporary; `let`
  declares a per-txn local (top-level `let` is E_SCOPE, shadowing is E_SCOPE).
- Static types: `Amount/Number/String/Bool/Status/Txn/Acct`. `revoke` only
  accepts `Txn`, so reversal always happens at whole-transaction granularity
  and debit/credit pairing holds by construction (the ledger loader also
  validates that every txn's debits equal its credits). A `revoke` guarded by
  `when tx.status == <terminal>` is rejected at compile time with E_STATE
  (illegal state-machine transition).

## Bytecode and VM

`revoke e` compiles to:

```
SAVEPOINT spN
<e> LOCK_CHECK        # pop txn; state/lock/dup check; E_LOCK/E_STATE/E_DUP
DISPATCH reverse compensate cancel skip
  REVERSE / COMPENSATE / CANCEL_REQUEST
COMMIT
```

The VM is stack-based and also provides `PUSH/LOAD/STORE/LOAD_FIELD`,
arithmetic/comparison/logic ops, `JMP/JMP_IF_FALSE`,
`ENTER_SCOPE/EXIT_SCOPE`, `PUSH_TXNS/PUSH_ALL_TXNS`,
`ITER_BEGIN/ITER_NEXT/ITER_END`, `HALT`.

## State machine

```
SETTLED  --revoke--> REVERSED        (originals -> REVERSED + paired mirrors)
LOCKED, day < currentDay (cross-day)
         --revoke--> originals stay LOCKED + compensation entries (no delete)
LOCKED, intraday hold --> E_LOCK
PENDING  --revoke--> CANCEL_REQUESTED (no balance change, not a failure)
REVERSED / CANCEL_REQUESTED / already compensated --> terminal, E_STATE
```

Balance model: `PENDING/CANCEL_REQUESTED` never post; everything else posts
(including REVERSED originals and their SETTLED mirror/compensation entries,
which net to zero).

## WAL and recovery

- Before every instruction the VM appends a WAL record (JSONL, fsynced):
  plain ops log `{seq,pc,op}`; `LOCK_CHECK` logs its `mode`; effect ops log
  the full deterministic `{effect}`; plus `SAVEPOINT/COMMIT/error/done`.
- Recovery = replay all effects (dedup by revId+txnId), then, if unfinished,
  resume the same plan on the replayed ledger. Already-processed txns are
  classified `skip` by `LOCK_CHECK` and jump straight to `COMMIT`, so crash
  recovery and re-execution are both idempotent.
- Idempotency key `revId`: explicit `param rev_id`, else the first 16 hex
  chars of the plan-source sha256. Re-submitting the same revId skips
  everything (ledger byte-identical); a different revId hitting a terminal
  txn raises E_STATE.

## Errors

Runtime errors are JSON on stderr: `{"error":{"code","message","txnId","pc"}}`.

| Code | Meaning |
|---|---|
| E_STATE | Illegal transition (terminal txn, unknown txn, unbalanced ledger) |
| E_LOCK | Intraday hold; entry must not be touched |
| E_DUP | Same txn targeted twice within one batch |
| E_IO | File read/write failure, corrupt WAL |

## Tests

```bash
node --test
```

Covers all four acceptance criteria: the three scenarios (plain revoke /
cross-day locked compensation / PENDING cancel-request), crash injection
after SAVEPOINT with recovery byte-identical to the no-crash reference
(including a crash matrix at every instruction boundary), no double reversal
on resubmission, and random 50-txn ledgers checked against a brute-force
state-machine oracle. See `RESULTS.md`.
