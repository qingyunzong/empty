# assertplan

Minimum-cost assertion planner (Go standard library only). Given up to **18
candidate assertions** and **12 fault models**, it selects the cheapest set of
assertions so that every fault model stays distinguishable from normal
behavior, then emits a coverage certificate.

## Model

- Each assertion has a cost, a set of fault models it distinguishes from
  normal, **public preconditions** (declared in the spec, disclosed in the
  certificate), and an optional **side-effect group**.
- **Side effects are mutually exclusive**: at most one assertion per
  non-empty side-effect group may be selected.
- Models no assertion can separate from normal are **indistinguishable**;
  they are excluded from the coverage target and listed separately.

## Solving

- `Greedy` builds a reference plan by lowest cost per newly covered model.
- `Exhaustive` performs the optimality cross-check: small-subset enumeration
  over all `2^18` subsets (262144), keeping the cheapest feasible plan and
  counting how many plans attain the optimum. `optima == 0` means the
  instance is infeasible under the mutex constraint.

## Usage

```sh
go run .                 # built-in 18x12 instance, certificate to stdout
go run . -o certificate.txt
go run . -spec examples/spec.json
```

Spec format: see `examples/spec.json` (mirrors the built-in instance).

## Built-in instance result

- Minimum cost **21** (A01, A03, A08, A09, A10, A11, A17); 2 optimal plans
  (A11 or A16 both cover M09 at cost 2).
- Greedy reference plan costs 25; enumeration confirms 21 is the minimum.
- M12 (firmware-mismatch) is indistinguishable and listed separately.

## Test results

`go test ./...` (go1.27.1 linux/amd64, 2026-10-05):

```
=== RUN   TestDefaultInstanceShape
--- PASS: TestDefaultInstanceShape (0.00s)
=== RUN   TestDefaultOptimalPlan
--- PASS: TestDefaultOptimalPlan (0.06s)
=== RUN   TestDefaultGreedyCrossCheck
--- PASS: TestDefaultGreedyCrossCheck (0.05s)
=== RUN   TestMutexExclusion
--- PASS: TestMutexExclusion (0.00s)
=== RUN   TestInfeasible
--- PASS: TestInfeasible (0.00s)
=== RUN   TestValidationErrors
--- PASS: TestValidationErrors (0.00s)
=== RUN   TestCertificateSections
--- PASS: TestCertificateSections (0.06s)
=== RUN   TestRandomizedCrossCheck
--- PASS: TestRandomizedCrossCheck (0.03s)
=== RUN   TestExampleSpecMatchesDefault
--- PASS: TestExampleSpecMatchesDefault (0.00s)
=== RUN   TestRunCLI
--- PASS: TestRunCLI (0.12s)
PASS
ok  	assertplan	0.321s
```

`gofmt -l .` and `go vet ./...` are clean.
