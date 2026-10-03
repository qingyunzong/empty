# Settlement Invariant Checker

Bounded model checker (Node.js 22, standard library only) for the settlement
safety invariant: **no clerk may approve their own submission when the amount
exceeds the threshold**. Given a policy DSL subset and the invariant, it
searches for the minimal counterexample or emits a no-counterexample
certificate.

## Usage

```sh
node cli.js spec.json out.json   # out.json receives counterexample or proof
node --test                      # run the test suite
```

Exit codes: `0` success, `1` on `E_PARSE` (unreadable file, invalid JSON, or
schema violation), `2` on usage errors.

## Spec format (spec.json)

```json
{
  "subjects": ["alice", "bob"],            // 1..4 subjects
  "amounts": [0, 1, 50, 100, 101],         // subset of {0,1,50,100,101}
  "bound": 6,                              // max action-sequence length, 1..6
  "policy": {
    "roles": { "manager": { "inherits": ["clerk"] }, "clerk": {} },
    "subjectRoles": { "alice": ["manager"] },
    "rules": [
      { "id": "r1", "effect": "allow", "role": "clerk", "action": "submit" },
      { "id": "r2", "effect": "allow", "role": "clerk", "action": "approve", "revocable": true },
      { "id": "r3", "effect": "deny", "role": "clerk", "action": "approve", "minAmount": 101 }
    ]
  },
  "invariant": { "type": "no_self_approval_over_threshold", "threshold": 100 }
}
```

Semantics:

- **Inheritance**: a subject holds the transitive closure of its assigned roles.
- **Deny overrides**: any matching active `deny` rule wins over all `allow`
  rules; everything unmatched is denied by default.
- **Revocation is future-only**: `revoke(ruleId)` removes a `revocable` rule
  from that step onward; earlier steps are unaffected.
- Rules match when the subject holds the rule role, the action matches, and
  the amount is within `[minAmount, maxAmount]` (unbounded when omitted).

## Actions and canonical order

Sequence actions (canonical string form, amounts zero-padded to 3 digits):

- `submit(subject,amount)` — create a pending transaction (id = its index).
- `approve(subject,tx)` — approve a pending transaction; needs `approve`
  permission for the transaction amount.
- `revoke(ruleId)` — system action removing a revocable rule going forward.

Search is by increasing action count, then lexicographic order over canonical
action strings (`approve(...) < revoke(...) < submit(...)`); among tied
minimal counterexamples the lexicographically smallest is returned.

## Outputs

- `counterexample.json`: `result: "counterexample"`, `length`, `sequence`,
  `canonical`, and the `violation` record (submitter, approver, amount).
- `proof.json`: `result: "proof"`, `bound`, `coverage` (subjects x 2 actions
  x amounts), the full `combinations` list (`subject|action|amount`),
  `statesExplored`, and `certificate` = `sha256:` of the stable JSON encoding
  of `{amounts, bound, combinations, invariant, policy, subjects}`.

## Layout

- `lib/spec.js` — spec parsing/validation (`E_PARSE`), role-closure computation.
- `lib/machine.js` — transition system, authorization, invariant check.
- `lib/search.js` — bounded search, certificate generation/verification.
- `cli.js` — command-line entry (`main` is exported for in-process testing).
- `specs/` — example specs used by the acceptance tests.
- `testlib/helpers.js` — independent brute-force enumerator used to
  cross-check the library item by item.
