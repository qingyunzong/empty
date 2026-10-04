# txn-undo

Transaction undo library + CLI. Node.js 22, standard library only.

## Model

- **Events**: `open`, `debit`, `credit`, `hold`, `release`, `commit`, `void`,
  `undo`, plus `repair` (the only event accepted in ERROR). JSONL in, JSON out.
- **Lifecycle DFA** (`src/dfa.js`): explicit transition table over
  `INIT / OPEN / COMMITTED / VOIDED / ERROR`. Any unlisted (state, op) pair is
  an illegal transition: the account enters ERROR and only `repair` is
  accepted afterwards.
- **Undo** (`src/ledger.js`): `undo` events carry a `target` event id and apply
  the inverse command (debit<->credit, hold<->release, commit/void -> reopen).
  Undoability is decided from the parent pointers of the event DAG: the target
  must be an ancestor of head on the same branch and have no later
  same-account events on the path to head. Violations raise FORK_CONFLICT with
  a witness (`{fork, headPath, targetPath}` or `{path, conflicts}`) instead of
  failing silently.
- **Batches**: `beginBatch(id, {onChildFailure})` / `endBatch()` nest. A failed
  event fails the innermost batch; ending a failed batch rolls back exactly
  its own subtree (account states, history events, head). The parent either
  continues (`'continue'`, default) or aborts the whole tree (`'abort'`).
  Results are deterministic.
- **Journal** (`src/journal.js`): append-only records
  `event -> snapshot -> head` per successful commit. Fault points:
  `beforeEvent`, `afterEvent`, `afterSnapshot`. `recover()` replays to the most
  recent consistent head, ignores later events, treats duplicate events as
  idempotent by id, verifies the journaled snapshot against replayed state,
  tolerates a torn final line, and raises CORRUPT_JOURNAL otherwise.
- **Error codes**: `ILLEGAL_TRANSITION`, `NEGATIVE`, `HOLD_LEAK`,
  `FORK_CONFLICT`, `CORRUPT_JOURNAL` (`src/errors.js`).

## Usage

```sh
node --test                                  # run the test suite
node cli.js replay journal.jsonl --repair    # recover + replay, auto-repair ERROR accounts
node cli.js replay journal.jsonl --undo e7   # also print the undo plan for event e7
```

CLI output: `{ head, accounts: {name: {state, balance, held}}, repairs,
ignoredEvents, undoPlan }`. Input may be journal records (`{type:...}` lines)
or a raw JSONL event stream.
