# rulecheck

Access-control rule library over path globs, in pure Go (standard library
only).

## Semantics

- **Globs.** Patterns are `/`-separated segments: literals, `*` (exactly one
  segment) and `**` (zero or more segments). Partial wildcards (`ab*`) and
  empty segments are rejected.
- **Rules.** A `Rule` has an `Include` glob and optional `Excludes`
  (exception globs). A path matches a rule when it matches `Include` and no
  exclusion.
- **Priority.** More specific rules win. Specificity is the number of
  literal segments first, then the total segment count. Two rules with equal
  specificity whose effective languages overlap are rejected by
  `NewLibrary` as ambiguous (disjoint ties are allowed).
- **Decision.** `Matcher.Match` returns the hit rule (`Decision.RuleID` /
  `Decision.Include`) or no match.

## Symbolic automata

Each rule is compiled into an inspectable deterministic symbolic automaton
(`Automaton`): the alphabet is one class per literal in the rule set plus an
`<other>` class; transition tables are total. Exclusions are compiled as
`Include ∩ ¬Excl₁ ∩ ¬Excl₂ …` via product construction.

## Diagnosis

`Library.Diagnose` reports, for every rule, either

- the **shortest witness path** on which the rule is selected (BFS over the
  product of the rule's automaton with the complements of all
  higher-priority automata), or
- a **complete empty-language certificate** (`EmptyCertificate`): whether
  the rule is empty by itself (`SelfEmpty`), the higher-priority rules
  covering it (`ShadowedBy`), and the explored proof size. Certificates are
  independently checkable with `cert.Verify(lib)`.

## Cache and hot reload

`Matcher` caches decisions per path. `Matcher.Reload(lib)` swaps in a
freshly compiled `Library` and a brand-new cache — no old automaton state or
cached decision is reused. `MatchNoCache` is the cache-free matcher used to
cross-check cached results.

## Verification

Tests cross-check the cached automaton matcher against the cache-free
matcher and an independent recursive glob matcher by enumerating every path
up to length 4 over the rule alphabet plus an unknown segment, before and
after hot reload. Witness minimality is checked against brute-force
enumeration.

## Test results (actual)

```
$ go test ./...
ok  	rulecheck	0.022s
```

All 11 tests pass (`go1.27.1 linux/amd64`), including
`TestEnumerationCrossCheck`, `TestHotReloadNoStaleState`,
`TestWitnessAgainstEnumeration` and `TestCertificateRejectsForgery`.
