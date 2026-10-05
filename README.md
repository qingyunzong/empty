# denyproof

CLI that reads up to 18 integer-interval rules and one request, then finds
the **minimum subset of rules that still proves the request is denied**.
Ties between equal-size subsets are broken by ID order. Standard library
only.

## Input (stdin)

```
N
<id> <layer> <action> <lo> <hi>    (N lines, 0 <= N <= 18)
<v>
```

- `<id>`: unique, non-empty token.
- `<layer>`: integer inheritance layer.
- `<action>`: `allow` or `deny`.
- `<lo> <hi>`: inclusive integer interval, `lo <= hi`.
- `<v>`: the integer request value.

## Output (stdout)

- If some subset proves denial: the subset size on line 1, then the
  subset's IDs (sorted) on line 2.
- If no subset (not even all rules) denies the request: `NONE`.

Exit codes: `0` success, `2` invalid input, `1` internal verification
failure (never expected).

## Public semantics

1. **Match**: a rule matches request value `v` iff `lo <= v <= hi`.
2. **Inheritance layers**: among matching rules, only those at the
   *highest* layer decide; lower layers are inherited away (a child
   layer overrides its parent).
3. **Deny priority**: within the deciding layer, any matching `deny`
   rule makes the outcome *deny*, regardless of matching `allow` rules.
4. **Default allow**: if no rule matches, the request is *allowed* —
   a denial must be actively proven by the rules present.

A subset **proves denial** iff these semantics yield *deny* when only
the subset's rules are consulted.

## Minimality and tie-break

The answer is the subset of smallest cardinality that proves denial.
Among equal-size candidates, the one whose sorted ID list is
lexicographically smallest (byte-wise) wins ("same size, ID order").

The search is exhaustive: subsets are enumerated in increasing size and,
within one size, in lexicographic ID order, so the first denying subset
found is the unique answer.

## Independent verification

`VerifyMinimal` re-checks every answer through a separate code path
(bitmask enumeration over all 2^n subsets): the answer itself denies,
**no strictly smaller subset denies**, and no equal-size subset earlier
in ID order denies. The CLI runs this check on every answer and reports
`verified: ...` on stderr.

## Exhaustive acceptance

`go test ./...` runs, among others:

- `TestExhaustiveAcceptanceRandom`: 2000 randomized instances
  cross-checked against an independent brute-force reference over all
  subsets.
- `TestExhaustiveSmallSpace`: every rule set of up to 3 rules over a
  tiny domain, for every request value, checked against the reference.
- `TestMinSubsetMaxSize`: the 18-rule limit end to end.

## Example

```
$ printf '3\na 0 deny 0 4\nb 1 allow 0 10\nc 2 deny 5 5\n5\n' | go run .
1
c
```

Rule `c` alone (layer-2 deny covering 5) proves the denial; the
lower-layer allow `b` cannot override it, and no smaller (empty) subset
denies.
