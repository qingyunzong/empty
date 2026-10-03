# Payment Workflow

Crash-safe scheduled payment workflow with an event-sourced core and a JSON CLI.
Node.js 22, standard library only, tests via `node:test`.

## Usage

```sh
node src/cli.js --state <dir> --cmd '<json>' [--crash-point <STAGE>]
node src/cli.js --state <dir> --cmd-file <path>
```

Commands:

```json
{"type":"PAY","commandId":"c1","paymentId":"p1","amount":100}
{"type":"CANCEL","commandId":"c2","paymentId":"p1"}
```

On success the CLI prints a JSON certificate (status, applied stages, balances)
and exits 0. On error it prints `{"ok":false,"error":{"code","message"}}` and
exits 1.

## Design

- Stages run in fixed order: `VALIDATED -> FROZEN -> POSTED -> NOTIFIED`.
- Before every stage, a stage event is appended to `<state>/events.jsonl`
  (fsync) and only then is the derived state applied; `--crash-point <STAGE>`
  kills the process (SIGKILL) in between, simulating a crash.
- Restart re-reduces the event log: persisted stages take effect exactly once,
  unfinished stages resume, finished stages are never re-applied.
- `CANCEL` before `POSTED` cancels the payment and releases the freeze; after
  `POSTED` the payment is kept and a reversing refund is posted (`REFUNDED`).
- `commandId` and `paymentId` are idempotent: repeats return the current
  certificate without new effects.

## Tests

```sh
node --test
```

`test/workflow.test.js` enumerates the four crash points and three cancel
arrival points independently and derives the expected terminal states from
those enumerations.
