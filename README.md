# matrix — pairwise test-matrix generator

`matrix` picks a minimum set of test configurations covering every legal
value pair across finite dimensions, subject to forbidden combinations and
preconditions. Pure Go standard library.

## Spec format (JSON)

```json
{
  "dimensions": [{"name": "os", "values": ["linux", "mac", "win"]}],
  "forbidden": [{"os": "win", "browser": "safari"}],
  "requires": [{"if": {"browser": "safari"}, "then": {"os": "mac"}}]
}
```

- `forbidden`: partial assignments no configuration may contain.
- `requires`: a configuration matching `if` must also match `then`.

## Usage

```
go run ./cmd/matrix -spec examples/spec.json -cert cert.json    # default limit: 30 configs
go run ./cmd/matrix -max 30 < spec.json > cert.json             # stdin/stdout
```

The certificate lists the chosen configurations, one covering configuration
per coverable pair, and the uncoverable pairs (pairs no legal configuration
can contain) separately. `minimality` is `exact` when the minimum was proven
by exhaustive search, otherwise `greedy`. Every certificate is re-verified
against the spec before output; `matrix.Certificate.Verify` re-checks
legality and coverage independently.

## Tests

```
go test ./...
```

Includes a cross-check of the solver against full subset enumeration on
small random specs (`TestExhaustiveSmallSpecs`).
