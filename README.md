# hdrclient

Determines the real client address from a forwarding header (e.g.
`X-Forwarded-For`) by stripping configured trusted proxies **right to left**
and attributing the **first untrusted** address as the client.

## Behavior

- Each chain element may be IPv4 or IPv6, with an optional port:
  `1.2.3.4`, `1.2.3.4:8080`, `::1`, `[2001:db8::1]:443`.
- An element that fails to parse **stops analysis immediately** and is
  reported via `Result.Stop` (reason `invalid-address`); it is never skipped.
- A source header appearing more than once is rejected (`ErrDuplicateHeader`).
- If every element is trusted, the leftmost one is attributed
  (`chain-exhausted`).
- IPv4-mapped IPv6 identity unification (`::ffff:1.2.3.4` ≡ `1.2.3.4`) is
  controlled by the table's input switch and frozen into each snapshot.

## Trusted-prefix table

- Updates are transactional: `Begin()` → `Trust`/`Deny`/`Remove` → `Commit`
  (atomic, all-or-nothing) or `Rollback`.
- Classification uses longest-prefix match; `Deny` entries act as exceptions
  that reject addresses inside broader trusted ranges.
- `Table.Snapshot()` returns an immutable view; an `Analyzer` binds one
  snapshot, so later table updates never affect it.

## Evidence

`Result.Steps` records every evaluated element (right to left) with the exact
`Rule` applied; `Result.Stop` records why stripping stopped, including the
deny/no-match rule or the parse error.

## Example

```go
tab := hdrclient.NewTable(true) // unify IPv4-mapped IPv6
tx := tab.Begin()
tx.Trust(must(hdrclient.ParsePrefix("10.0.0.0/8", true)))
tx.Deny(must(hdrclient.ParsePrefix("10.9.0.0/16", true))) // exception
_ = tx.Commit()

an := hdrclient.NewAnalyzer(tab.Snapshot(), "X-Forwarded-For")
res, err := an.Analyze(req.Header)
// res.Client / res.Steps / res.Stop
```

## Test

```sh
go test ./...
```
