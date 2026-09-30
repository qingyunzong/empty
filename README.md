# Idempotent Task Inbox

Persistent, crash-safe task inbox with idempotent enqueue and processing.
Python 3.11+ standard library only.

## Commands

```
python3 inbox.py [--dir DIR] enqueue '{"idemkey":"k","payload":"p"}'
python3 inbox.py [--dir DIR] run-once [IDEMKEY]
python3 inbox.py [--dir DIR] crash --after CLAIM IDEMKEY
python3 inbox.py [--dir DIR] recover
python3 inbox.py [--dir DIR] get IDEMKEY
```

Storage directory defaults to `./inbox` or `$INBOX_DIR`. It contains an
append-only `journal.log` (ENQUEUE / CLAIM / RESULT events, fsynced), an
atomically replaced `results.json` (task records), and `effects.json`
(side effects keyed by idemkey, guaranteeing idempotent re-execution).

## States

`RECEIVED` -> `PROCESSING` -> `SUCCEEDED` | `FAILED`

A CLAIM event is persisted atomically before processing; the result is
written only after processing completes. After a crash following CLAIM,
`recover` re-runs the task with the same idemkey; the built-in processor
applies its side effect at most once per effect key. Payload `BAD` fails
permanently and is never retried.

## Exit codes

| Code | Meaning                          |
|------|----------------------------------|
| 0    | success                          |
| 2    | duplicate run while PROCESSING   |
| 3    | persistent storage corrupted     |
| 4    | invalid input                    |
| 10   | permanent processing failure     |

## Tests

```
python3 -m unittest -v
```

Tests drive the real CLI via subprocess and assert persisted state and
side effects against a reference mapping of idemkey -> state/effects.
Latest real run output is recorded in `result.txt`.
