# Settlement Invariant Checker

Library and CLI that, given a policy DSL subset and the invariant
"no settlement clerk may approve their own submission above the threshold",
either finds the **minimal counterexample** or emits a **proof certificate**
covering every subject-action-amount combination.

Node.js 22, standard library only, tests via `node:test`.

## Usage

```sh
node cli.js spec.json out.json   # writes counterexample.json or proof.json
node --test                      # run the test suite
```

Exit codes: `0` success, `1` spec read/parse/validation failure (`E_PARSE`),
`2` wrong argument count.

## Spec format (spec.json)

```json
{
  "threshold": 100,
  "subjects": ["alice", "bob", "carol", "dave"],
  "actions": ["submit", "approve"],
  "amounts": [0, 1, 50, 100, 101],
  "maxLength": 6,
  "roles": { "clerk": ["employee"], "employee": [] },
  "assignments": { "alice": ["clerk"] },
  "rules": [
    { "id": "allow-submit", "effect": "allow", "role": "clerk", "action": "submit" },
    { "id": "deny-self", "effect": "deny", "role": "clerk", "action": "approve", "self": true }
  ],
  "revocations": [{ "rule": "allow-submit", "at": 3 }],
  "invariant": { "role": "clerk", "first": "submit", "second": "approve" }
}
```

- `threshold` (required): amounts strictly greater than this violate.
- `subjects`: 1-4 unique names. `actions`: defaults to `["submit", "approve"]`.
- `amounts`: subset of `{0, 1, 50, 100, 101}` (default: the full set).
- `maxLength`: action-sequence bound, 1-6 (default 6).
- `roles`: role -> parent roles; permissions inherit down the hierarchy.
- `rules`: `effect` is `allow` or `deny`; optional conditions `self`
  (acting on one's own prior submission) and `amountGt`. **Deny wins.**
- `revocations`: `{rule, at}` deactivates a rule for positions `>= at` only;
  revocation is future-effective, never retroactive.
- `invariant`: `role` defaults to `clerk`; a violation is a subject with
  that role performing `first` then `second` on the same amount above the
  threshold, with both actions permitted at their positions.

## Search order and outputs

Canonical token order: subject (alphabetical), action (alphabetical), amount
(ascending). The search tries sequence lengths 2..maxLength and, within a
length, returns the lexicographically smallest canonical sequence; tied
minimal counterexamples resolve to that lexicographic minimum.

- `counterexample.json`: `{result, length, sequence, violation}`.
- `proof.json`: `{result, certificate}` where the certificate is a SHA-256
  hash over the normalized spec plus the full permission matrix
  (position x subject-action-amount combination x self-context), with
  `combinations = subjects x actions x amounts` and
  `evaluations = combinations x 2 x maxLength`.

## Layout

- `spec.js` - DSL parsing/validation (`SpecError`, code `E_PARSE`)
- `policy.js` - permission evaluation (inheritance, deny-priority, revocation)
- `search.js` - minimal-counterexample search, certificate, `analyze`
- `brute.js` - independent brute-force enumerator (test cross-check)
- `cli.js` - command-line entry
- `examples/` - ready-to-run specs; `test/` - `node:test` suites
