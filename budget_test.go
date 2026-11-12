package dataeng

import (
	"errors"
	"fmt"
	"testing"
)

func TestBudgetExactlyAtBoundary(t *testing.T) {
	// Each key's cheapest feasible shape uses 2 cells; two keys fit exactly
	// in P=4 while P=3 must be reported as a global budget failure.
	req := Request{
		Left:     []KeyCount{{"a", 5}, {"b", 5}},
		Right:    []KeyCount{{"a", 5}, {"b", 5}},
		Slots:    4,
		MaxPairs: 15,
	}
	plan := mustPlan(t, req)
	if plan.TotalCells != 4 {
		t.Fatalf("want exactly 4 cells, got %d", plan.TotalCells)
	}

	tight := req
	tight.Slots = 3
	wantFailure(t, tight, BudgetExceeded)

	// A single key whose minimum feasible shape consumes the whole budget.
	single := Request{
		Left:     []KeyCount{{"k", 8}},
		Right:    []KeyCount{{"k", 8}},
		Slots:    4,
		MaxPairs: 16,
	}
	singlePlan := mustPlan(t, single)
	if singlePlan.TotalCells != 4 {
		t.Fatalf("want 4 cells, got %d", singlePlan.TotalCells)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	req := Request{
		Left:     []KeyCount{{"k", 6}},
		Right:    []KeyCount{{"k", 4}},
		Slots:    6,
		MaxPairs: 100,
	}
	plan := mustPlan(t, req)
	assertMatchesOracle(t, req)
	if plan.Splits[0].R != 1 || plan.Splits[0].S != 1 {
		t.Fatalf("minimum transfer plan must keep (1,1), got (%d,%d)",
			plan.Splits[0].R, plan.Splits[0].S)
	}

	// Multi-key tie scenario validated against the oracle's lexicographic
	// sequence comparison.
	tied := Request{
		Left:     []KeyCount{{"a", 2}, {"b", 2}},
		Right:    []KeyCount{{"a", 2}, {"b", 2}},
		Slots:    8,
		MaxPairs: 4,
	}
	assertMatchesOracle(t, tied)
}

func TestRoutingAndPairEncounter(t *testing.T) {
	req := Request{
		Left:     []KeyCount{{"k", 5}, {"q", 3}},
		Right:    []KeyCount{{"k", 4}, {"q", 2}},
		Slots:    16,
		MaxPairs: 4,
	}
	plan := mustPlan(t, req)

	for _, split := range plan.Splits {
		leftCount := plan.leftCount[split.Key]
		rightCount := plan.rightCount[split.Key]

		for row := int64(0); row < leftCount; row++ {
			slots, err := plan.RouteLeft(split.Key, row)
			if err != nil {
				t.Fatalf("left route error: %v", err)
			}
			if len(slots) != split.S {
				t.Fatalf("left row %d routed to %d slots, want %d", row, len(slots), split.S)
			}
			if !sortedDistinct(slots) {
				t.Fatalf("left slots not sorted/distinct: %v", slots)
			}
		}
		for row := int64(0); row < rightCount; row++ {
			slots, err := plan.RouteRight(split.Key, row)
			if err != nil {
				t.Fatalf("right route error: %v", err)
			}
			if len(slots) != split.R {
				t.Fatalf("right row %d routed to %d slots, want %d", row, len(slots), split.R)
			}
			if !sortedDistinct(slots) {
				t.Fatalf("right slots not sorted/distinct: %v", slots)
			}
		}

		if slots, _ := plan.RouteLeft(split.Key, 0); slots[0] != split.SlotStart {
			t.Fatal("row 0 must land in bucket 0's first slot")
		}
		if _, err := plan.RouteLeft(split.Key, leftCount); err == nil {
			t.Fatal("out-of-range row number must be rejected")
		}
		if _, err := plan.RouteRight(split.Key, -1); err == nil {
			t.Fatal("negative row number must be rejected")
		}
		if _, err := plan.RouteLeft("missing", 0); err == nil {
			t.Fatal("unknown key must be rejected")
		}
	}

	seen := map[int]string{}
	for _, split := range plan.Splits {
		for slot := split.SlotStart; slot < split.SlotStart+split.Cells; slot++ {
			if owner, dup := seen[slot]; dup {
				t.Fatalf("slot %d shared by %q and %q", slot, owner, split.Key)
			}
			seen[slot] = split.Key
		}
	}
}

func sortedDistinct(values []int) bool {
	for i := 1; i < len(values); i++ {
		if values[i-1] >= values[i] {
			return false
		}
	}
	return true
}

func TestKeyOrderingIsBytewise(t *testing.T) {
	req := Request{
		Left: []KeyCount{
			{"\u00e9", 2},
			{"A", 2},
			{"a", 2},
			{"ab", 2},
		},
		Right: []KeyCount{
			{"\u00e9", 2},
			{"A", 2},
			{"a", 2},
			{"ab", 2},
		},
		Slots:    128,
		MaxPairs: 100,
	}
	plan := mustPlan(t, req)
	want := []string{"A", "a", "ab", "\u00e9"}
	for i, split := range plan.Splits {
		if split.Key != want[i] {
			t.Fatalf("position %d: got %q want %q", i, split.Key, want[i])
		}
	}
}

func TestInvalidInputs(t *testing.T) {
	base := Request{
		Left:     []KeyCount{{"k", 1}},
		Right:    []KeyCount{{"k", 1}},
		Slots:    2,
		MaxPairs: 1,
	}

	cases := map[string]func(*Request){
		"slots zero":          func(r *Request) { r.Slots = 0 },
		"slots too large":     func(r *Request) { r.Slots = 129 },
		"zero budget":         func(r *Request) { r.MaxPairs = 0 },
		"negative budget":     func(r *Request) { r.MaxPairs = -1 },
		"negative row count":  func(r *Request) { r.Left[0].Count = -1 },
		"row count too large": func(r *Request) { r.Right[0].Count = 1_000_000_000_001 },
		"duplicate left key": func(r *Request) {
			r.Left = append(r.Left, KeyCount{"k", 1})
		},
		"duplicate right key": func(r *Request) {
			r.Right = append(r.Right, KeyCount{"k", 1})
		},
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			req := base
			mutate(&req)
			plan, err := PlanSplit(req)
			if plan != nil {
				t.Fatalf("expected nil plan for %s", name)
			}
			var failure *Failure
			if !errors.As(err, &failure) || failure.Code != InvalidInput {
				t.Fatalf("expected invalid_input for %s, got %v", name, err)
			}
		})
	}
}

func TestKeyLimitBoundary(t *testing.T) {
	req := Request{Slots: 128, MaxPairs: 1}
	for i := 0; i < MaxKeys; i++ {
		key := fmt.Sprintf("k%02d", i)
		req.Left = append(req.Left, KeyCount{key, 1})
		req.Right = append(req.Right, KeyCount{key, 1})
	}
	plan := mustPlan(t, req)
	if len(plan.Splits) != MaxKeys || plan.TotalCells != MaxKeys {
		t.Fatalf("64 single-cell keys must fit, got splits=%d cells=%d",
			len(plan.Splits), plan.TotalCells)
	}

	tooMany := req
	tooMany.Left = append(tooMany.Left, KeyCount{"extra", 1})
	tooMany.Right = append(tooMany.Right, KeyCount{"extra", 1})
	wantFailure(t, tooMany, InvalidInput)
}

func TestVerifyRejectsTamperedPlan(t *testing.T) {
	req := Request{
		Left:     []KeyCount{{"k", 4}},
		Right:    []KeyCount{{"k", 4}},
		Slots:    4,
		MaxPairs: 4,
	}
	plan := mustPlan(t, req)

	tampered := *plan
	tampered.Splits = append([]KeySplit(nil), plan.Splits...)
	tampered.Splits[0].Cells++
	if err := tampered.Verify(); err == nil {
		t.Fatal("Verify must reject an inconsistent cell count")
	}

	overBudget := *plan
	overBudget.Splits = append([]KeySplit(nil), plan.Splits...)
	overBudget.Splits[0].SlotStart = plan.slots
	if err := overBudget.Verify(); err == nil {
		t.Fatal("Verify must reject slot ranges outside the budget")
	}
}
