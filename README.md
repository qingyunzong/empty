# rev — reversal DSL + bytecode VM with WAL crash recovery

`rev` rolls back posted payment transactions using a small reversal script
(`.rvx`). It compiles the script to bytecode, executes it on a stack VM, and
logs every bytecode to a WAL *before* executing it, so a crash at any point
can be recovered deterministically. Single machine, offline, Node.js 22,
standard library only.

## CLI

```sh
rev run plan.rvx ledger.json --wal wal.log [--out ledger.out.json]
rev recover --wal wal.log [--out ledger.out.json]
```

- `run` compiles and executes the plan, then writes the updated ledger
  (in place unless `--out` is given). Re-running with the same committed WAL
  is an idempotent no-op.
- `recover` reads the plan source and ledger snapshot from the WAL header,
  deterministically re-executes the plan, replays effects already durable in
  the WAL by their idempotency key, and continues past the crash point. The
  resulting ledger is identical to a crash-free run. `recover` is itself
  idempotent.

## DSL

```
param reason = "chargeback";            # global param (immutable)

for t in [txn:1001, txn:1002, txn:1003] {
  let amt = t.amount;                   # txn-local, fresh each iteration
  if t.status == SETTLED and amt > 0 {
    reverse t;                          # void, or compensate when locked
  } else if t.status == PENDING {
    cancel t;                           # -> CANCEL_REQUESTED, never posts
  }
}

move 2.50 from acc:revenue.fees to acc:cash.operating;
```

- **Lexer**: `txn:<id>` refs, `acc:<name>` accounts, money literals
  (`12.50` -> cents), status keywords (`SETTLED PENDING CANCEL_REQUESTED
  REVERSED FAILED`, plus entry flag `LOCKED`), `#`/`//` comments.
- **Pratt parser**: `or < and < ==/!= < </<=/>/>= < +/- < * < prefix
  not/- < attribute access (`.`), lists `[txn:1, txn:2]`.
- **Static types**: `money int string bool status txn account list_txn`.
  `move` requires both `from`/`to` account literals, so debit/credit legs
  are always paired. `reverse`/`cancel` require `txn` operands. Comparing
  `t.status` against `LOCKED` is a type error (it is an entry flag; use
  `t.locked`).
- **Scopes**: global `param`s, per-txn `let` locals (fresh each loop
  iteration), and loop temporaries (the loop variable). Loop bindings are
  not visible outside the loop.

## Bytecode & VM

Compiler targets a stack VM. A `reverse` statement compiles to:

```
SAVEPOINT reverse
<target>  DUP  LOCK_CHECK  JZ normal
COMPENSATE  JMP end
normal: REVERSE
end: COMMIT
```

Opcodes: `PUSH LOAD STORE GETATTR LIST ADD SUB MUL NEG EQ NE LT LE GT GE
AND OR NOT JZ JMP ITER_INIT ITER_NEXT EXIT_SCOPE DUP SAVEPOINT LOCK_CHECK
REVERSE COMPENSATE CANCEL MOVE COMMIT HALT`.

## Semantics

- Reversal only targets `SETTLED` / `PENDING` transactions
  (`SETTLED -> REVERSED`, `PENDING -> CANCEL_REQUESTED`); anything else is
  `E_STATE`.
- `PENDING` can only be marked `CANCEL_REQUESTED` — it never posts entries
  and never becomes `REVERSED` out of thin air.
- Cross-day entries (`txn.day < currentDay` or `locked: true`) are
  **compensated**: mirrored counter-entries dated today are appended and
  the originals are kept. Same-day entries are physically voided (kept
  under `voidedEntries` for audit).
- Every effect carries a deterministic idempotency key (`rev:<txnId>`,
  `mov:<pc>`); re-applying one is `E_DUP`.

## WAL & crash recovery

- Before executing **every** bytecode, the VM appends a `pc` record to the
  WAL. Effects are appended before they are applied to the ledger, so the
  log is always ahead of the state.
- The WAL header stores the plan source, its hash, and the ledger snapshot,
  making the WAL self-contained for recovery.
- Crash injection for testing: `REV_CRASH_AT_EFFECT=<n> rev run ...` exits
  with code 3 right after the n-th effect is logged, before it is applied.

## Errors

`RevError` carries `code`, `txnId`, and `pc`; the CLI prints e.g.
`error[E_STATE] txn=1001 pc=7: cannot reverse txn in status REVERSED` and
exits 1.

- `E_STATE` — illegal state transition / unknown txn
- `E_LOCK` — frozen account touched by `move`
- `E_DUP` — effect idempotency key already applied
- `E_IO` — ledger/WAL read/write failures
- `E_PARSE` / `E_TYPE` — compile-time failures

## Ledger format

```json
{
  "currentDay": 3,
  "accounts": { "vault.frozen": { "frozen": true } },
  "txns": [
    { "id": "1001", "status": "SETTLED", "day": 3,
      "entries": [ { "account": "cash.operating", "debit": 12500, "credit": 0 } ] }
  ]
}
```

Amounts are integer cents. `applied` tracks idempotency keys.

## Tests

```sh
node --test
```
