# PLC Event Gateway (offline, stdlib-only)

Queries `events.jsonl` and decides, per event and tenant, whether the event may
be **read**, **modified** or **marked as false positive**. Output is a
visibility bitmap per event plus an `audit.jsonl` explaining every decision.

Runtime: Node.js 22, standard library only. Tests: `node --test`.

## Commands

```
node src/cli.js query --policy P.json --events E.jsonl --tenant T [--at TS] [--window W] [--audit audit.jsonl]
node src/cli.js stats --policy P.json --events E.jsonl --tenant T [--at TS] --store stats.json [--window W]
```

- `query` prints one JSON line per event: `{event, tenant, bitmap, allowed, denied, ...}`.
  Bitmap bits: `read=1`, `modify=2`, `mark_false_positive=4`.
- `stats` derives per-tenant counts and stores them in `--store`. Derived
  statistics are **immutable snapshots**: recomputing after a revocation
  returns the original snapshot (`"snapshot": true`). Detail queries are
  always rebuilt at query time and therefore reflect revocations.

## Policy model (`policy.json`)

- `tenants`: hierarchy via `parent`; member tenants inherit group grants/denies. A cycle exits with code **4**.
- `tags` / `devices`: devices carry tags; any reference to an undeclared tag exits with code **9**.
- `grants` / `denies`: `{id, tenant, tag, actions}` — tag-level authorization.
- `exceptions`: `{id, event, tenant, action, effect}` — event-level allow/deny, coexisting with tag rules.
- `revocations`: `{id, grant, ts, tenant?}` — withdraws a grant (for one tenant, or everyone if `tenant` is omitted) at/after `ts`.

## Decision semantics

1. Collect allows (active grants inherited through the tenant chain + allow
   exceptions) and denies (deny rules + deny exceptions).
2. **Deny beats allow.** Exception: an event of type `shutdown` carrying the
   `safety-public` tag is publicly **readable** — the tag breaks read-denies,
   and every break is recorded (`broken`, `breakReason`) in the audit.
3. Otherwise default-deny.
4. Every denial carries a **minimal counterexample**: a single change that
   would flip the decision — `extra-revocation` (which revocation is too
   much), `extra-deny` (which deny rule is too much), or `missing-grant`
   (the minimal grant `{tenant, tag, action}` that is absent).

## Events (`events.jsonl`)

One JSON object per line: `{id, ts, device?, type}`. Events may arrive
slightly out of order; an event more than `--window` (default 300) behind the
maximum ts seen exits with code **8**.

`{"type":"mark_false_positive","target":"<eventId>","tenant":"..."}` marks an
event as false positive. The marking is applied only if the marking tenant
held `mark_false_positive` permission on the target **at marking time**;
applied markings show up on the original event as `falsePositive`, rejected
ones as `"markingStatus":"rejected"` with an audit reason.

## Exit codes

| code | meaning |
|------|---------|
| 4 | tenant hierarchy cycle |
| 8 | events out of order beyond window |
| 9 | unknown tag referenced |

## Tests

`npm test` (i.e. `node --test`) runs unit tests plus acceptance tests:
A cross-tenant same-device visibility, B revocation vs frozen stats with
explainable audit, C false-positive marking consistency, D enumeration of
≤12 subjects/tags cross-checked against a naive reference evaluator.
