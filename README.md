# hdrclient

Request-header client attribution for Go. It walks a forwarding chain
(e.g. `X-Forwarded-For`) from right to left, peeling configured trusted
proxy hops and attributing the request to the first untrusted address.

## Rules

- **Right-to-left strip**: only the first untrusted address from the
  right becomes the client; everything left of it is ignored, so
  attacker-controlled leading entries cannot forge attribution.
- **Strict parsing**: IPv4 and IPv6 with optional ports (`1.2.3.4`,
  `1.2.3.4:80`, `2001:db8::1`, `[2001:db8::1]:443`). A malformed token
  stops the walk and is reported — entries are never skipped.
- **Duplicate source headers are rejected** outright.
- **Trusted prefix table**: transactional updates (`Begin`/`Commit`/
  `Rollback`, optimistic conflict detection), longest-prefix match with
  deny exceptions (deny wins ties).
- **IPv4-mapped IPv6 identity** follows a config switch:
  `SetUnifyIPv4MappedIPv6(true)` treats `::ffff:10.0.0.1` as `10.0.0.1`;
  `false` keeps them distinct. The switch applies to both parsed
  addresses and rules.
- **Snapshot binding**: an `Analyzer` is bound to an immutable config
  snapshot; later table updates never affect in-flight analysis.
- **Evidence**: every `Result` records each peeled hop with the exact
  rule used (`Strips`) plus the stop reason and evidence (`Stop`,
  `Evidence`, `Report()`).

## Example

```go
tbl := hdrclient.NewTable()
tx := tbl.Begin()
tx.SetUnifyIPv4MappedIPv6(true)
tx.Trust("edge", mustPrefix("10.0.0.0/8"))
tx.Deny("dmz", mustPrefix("10.9.0.0/16")) // exception: not trusted
tx.Commit()

a := hdrclient.NewAnalyzer(tbl.Snapshot(), "X-Forwarded-For")
res := a.Analyze([]string{"203.0.113.7, 10.1.0.1"}, "10.0.0.9:443")
if res.OK() {
    fmt.Println("client:", res.Client)
}
fmt.Println(res.Report()) // per-hop rules + stop evidence
```

## Test

```sh
go test ./...
```
