# ledger-audit

Offline settlement-batch audit library and CLI. Node.js 22, standard library
only, no network access. Tests use `node:test`.

## Data formats

`ledger.jsonl` — one JSON object per line:

```json
{"batch":"B1","account":"A001","currency":"CNY","amount":100.5,"direction":"credit","timestamp":"2026-10-01T08:00:00Z"}
```

Fields: `batch`, `account` (non-empty strings, no `|`/newlines), `currency`
(`[A-Z]{3}`), `amount` (finite number, `0 <= amount <= 1e12`), `direction`
(`debit`|`credit`), `timestamp` (ISO 8601). Limits: 50000 lines, 8192
chars/line. Violations are reported as `BAD_LINE`.

`rules.json`:

```json
{"rules":[{"id":"cny-credit","pattern":"[^|]*\\|[^|]*\\|CNY\\|[^|]*\\|credit\\|[^|]*","decision":"flag"}]}
```

`decision` is `flag` or `pass`. Patterns are matched against the canonical
concatenation `batch|account|currency|amount|direction|timestamp`
(full-string match; use `[^|]*` to skip a field).

## Restricted regular expressions

Supported: literals, character classes (`[abc]`, `[a-z]`, `[^...]`),
concatenation, union `a|b`, star `a*`, optional `a?`, parentheses, and
backslash-escaped metacharacters. Everything else is rejected with
`BAD_REGEX` — including backreferences (`\1`), `+`, `{n}`, `.`, anchors and
unknown escapes. Rules are limited to 80 characters.

## Core mechanisms

1. **Regex -> NFA -> DFA -> minimal DFA.** Thompson construction, subset
   construction over an atomic partition of the code-point space, then
   partition refinement. Minimization emits a *verifiable partition
   certificate*: the state blocks, the quotient transition table, and a
   distinguishing string for every pair of blocks.
   `verifyMinimization(complete, certificate)` independently checks that the
   blocks form an exact partition, are internally consistent (a congruence),
   and are pairwise distinguishable — together proving minimality.
2. **Rule-set equivalence.** Both sets are compiled to DFAs over a shared
   alphabet partition; BFS on the product automaton finds the first
   divergence. Because atoms are expanded in increasing code-point order,
   the witness is the shortest distinguishing string and, among those, the
   numerically smallest. Output: `{equiv, witness, side}`.
3. **Versioned rules with explicit snapshots.** `apply` validates and
   installs a new rule set (nothing is written on `BAD_REGEX`). `snapshot`
   records the current hash/rules explicitly. `undo` reverts to the most
   recent explicit snapshot only; with none it fails with `NO_SNAPSHOT` and
   leaves the state file untouched. State hash is
   `sha256(canonical rules JSON)`.
4. **Conflicts are never silent.** A line matching both `flag` and `pass`
   rules aborts the audit with `AMBIGUOUS_RULE` instead of being treated as
   a non-match.

## CLI

```
node cli.js audit <rules.json> <ledger.jsonl>   # -> { match, summary }
node cli.js equiv <rulesA.json> <rulesB.json>   # -> { equiv, witness, side }
node cli.js minimize <rules.json>               # -> { minimized: {..., certificate} }
node cli.js apply <rules.json> --state <file>
node cli.js snapshot --state <file>
node cli.js undo --state <file>
```

Success prints JSON on stdout (exit 0). Errors print
`{"error":{"code","message"}}` on stderr (exit 1) with codes `BAD_REGEX`,
`BAD_LINE`, `NO_SNAPSHOT`, `AMBIGUOUS_RULE`.

`audit` output: per-line `{line, batch, matched, decision}` plus
`summary: {lines, flaggedCount, flaggedByCurrency}` — flagged amounts are
summed per currency at cent precision.

## Library

```js
const { parse, compileAst, audit, equivPatterns, minimizePatterns,
        verifyMinimization, applyRules, snapshot, undo } = require('./index');
```

## Tests

```
node --test
```
