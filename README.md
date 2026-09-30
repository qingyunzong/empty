# Saga CLI

Saga orchestration over a JSON definition of ordered steps. Each step has a
commit action and a compensate action. Pure Python 3.11+ standard library.

## Definition format

```json
{"steps": [
  {"name": "A", "commit": {"op": "log"}, "compensate": {"op": "log"}},
  {"name": "B", "commit": {"op": "fail"}, "compensate": {"op": "log"}}
]}
```

Action ops: `log` (record the effect in `<id>.effects.log`) and `fail`
(simulate a failing action, drives the saga to FAILED).

## Commands

```
python3 saga.py new     --id S --def def.json --key REQ [--state-dir .saga]
python3 saga.py run     --id S [--state-dir .saga]
python3 saga.py cancel  --id S [--state-dir .saga]
python3 saga.py recover --id S [--state-dir .saga]
python3 saga.py state   --id S [--state-dir .saga]
```

States: `RUNNING`, `CANCELING`, `CANCELED`, `COMPLETED`, `FAILED`.

## Semantics

- `cancel` persists the cancel request before doing anything else; a running
  saga observes it at the next step boundary (cooperative checkpoint).
- On cancel, committed steps are compensated in reverse order; steps that
  never started are never executed.
- `cancel` on a `COMPLETED` saga exits with code 9 and leaves state unchanged;
  on a `CANCELED` saga it is an idempotent no-op (exit 0).
- Crash points are limited to: after a step event, after an action, after a
  compensation event. `recover` resumes the interrupted run or cancellation;
  the persisted cancel flag is never lost.
- All actions are idempotent, keyed by request key + step name + action type
  (the `action_ledger` in the state file).

## Exit codes

| code | meaning                                   |
|------|-------------------------------------------|
| 0    | success                                   |
| 2    | usage / saga error (incl. action failure) |
| 9    | conflict: cancel after COMPLETED          |
| 99   | simulated crash (SAGA_CRASH_AFTER set)    |

## Crash injection (testing recovery)

Set `SAGA_CRASH_AFTER` to a comma-separated list of tokens:

- `event:step_started:X`, `event:step_committed:X`, `event:compensated:X`
- `action:commit:X`, `action:compensate:X`

The process exits abruptly with code 99 right after the matching persisted
event/action; `recover` then resumes without re-executing completed actions.

## Tests

```
python3 -m unittest -v > result.txt 2>&1
```

(Any Python 3.11+ interpreter works; in this environment the binary is
`python3`, there is no `python` alias.) Latest real run: 8 tests, OK —
see `result.txt`.
