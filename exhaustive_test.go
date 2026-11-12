package dataeng

import (
	"strings"
	"testing"
)

// TestEightFieldExhaustive exercises the maximum shape and cross-checks that
// every enumerated record is old-valid, while counting them against the
// analytic DomainSize.
func TestEightFieldExhaustive(t *testing.T) {
	fields := make([]FieldSpec, 8)
	for i := range fields {
		name := string(rune('a' + i))
		switch i % 3 {
		case 0:
			fields[i] = optionalInt(name, i%2 == 0, []int{1, 2})
		case 1:
			fields[i] = requiredInt(name, []int{3, 4})
		default:
			fields[i] = arrayField(name, []int{5, 6}, 0, 2)
		}
	}
	old := &Schema{Fields: fields}
	size, err := DomainSize(old)
	if err != nil {
		t.Fatalf("DomainSize error: %v", err)
	}

	oldC, err := compile(old)
	if err != nil {
		t.Fatalf("compile error: %v", err)
	}
	values := oldC.buildPresentValues()
	var counted uint64
	for k := 0; k <= len(oldC.fields); k++ {
		indices := make([]int, k)
		for init := 0; init < k; init++ {
			indices[init] = init
		}
		for {
			domains := make([][]Value, k)
			for pos, idx := range indices {
				domains[pos] = values[idx]
			}
			var walk func(pos int, tuple []Value)
			walk = func(pos int, tuple []Value) {
				if pos == k {
					rec := make(Record, k)
					for p, idx := range indices {
						rec[oldC.fields[idx].Name] = tuple[p]
					}
					ok, _ := oldC.accept(rec)
					if !ok {
						// Subsets that omit required fields are outside the
						// old domain and therefore outside DomainSize.
						return
					}
					counted++
					return
				}
				for _, v := range domains[pos] {
					walk(pos+1, append(tuple, v))
				}
			}
			walk(0, nil)
			if !nextCombination(indices, len(oldC.fields)) {
				break
			}
		}
	}
	if counted != size {
		t.Fatalf("enumerated %d records, domain size predicts %d", counted, size)
	}
}

// TestExampleFlow mirrors the host-facing usage from the package README.
func TestExampleFlow(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{
		optionalInt("mode", true, []int{0, 1}),
	}}
	new := &Schema{Fields: []FieldSpec{
		optionalInt("mode", false, []int{0, 1}),
	}}

	res, err := Check(old, new)
	if err != nil {
		t.Fatalf("Check error: %v", err)
	}
	if res.Counterexample == nil {
		t.Fatal("expected null-tightening counterexample")
	}
	if res.Counterexample.Record.String() != `{"mode":null}` {
		t.Fatalf("unexpected record: %s", res.Counterexample.Record)
	}
	if !strings.Contains(res.Counterexample.Reason, "null") {
		t.Fatalf("reason should mention null: %s", res.Counterexample.Reason)
	}
}
