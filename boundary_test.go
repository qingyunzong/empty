package dataeng

import (
	"errors"
	"testing"
)

func TestHeavyKeySkew(t *testing.T) {
	req := Request{
		Left:     []KeyCount{{"huge", 1_000_000_000_000}},
		Right:    []KeyCount{{"huge", 1}},
		Slots:    128,
		MaxPairs: 1_000_000_000_000,
	}
	plan := mustPlan(t, req)
	if len(plan.Splits) != 1 {
		t.Fatalf("want 1 split, got %d", len(plan.Splits))
	}
	split := plan.Splits[0]
	if split.R != 1 || split.S != 1 {
		t.Fatalf("want (r,s)=(1,1), got (%d,%d)", split.R, split.S)
	}
	if split.Cells != 1 || plan.TotalCells != 1 {
		t.Fatalf("want 1 cell, got %d", plan.TotalCells)
	}
	if plan.TotalTransferredRows != 1_000_000_000_001 {
		t.Fatalf("unexpected transfer %d", plan.TotalTransferredRows)
	}

	slots, err := plan.RouteLeft("huge", 999_999_999_999)
	if err != nil || len(slots) != 1 || slots[0] != 0 {
		t.Fatalf("unexpected left route: %v, err=%v", slots, err)
	}
	rightSlots, err := plan.RouteRight("huge", 0)
	if err != nil || len(rightSlots) != 1 || rightSlots[0] != 0 {
		t.Fatalf("unexpected right route: %v, err=%v", rightSlots, err)
	}
}

func TestMultiplicationOverflowIsRejectedSafely(t *testing.T) {
	// ceil(L/r)*ceil(R/s) at r=s=1 is 1e24, far outside int64. With
	// B <= 1e12 and r*s <= 128 every choice remains infeasible; the overflow
	// guard must prevent a wrapped-around false positive.
	req := Request{
		Left:     []KeyCount{{"k", 1_000_000_000_000}},
		Right:    []KeyCount{{"k", 1_000_000_000_000}},
		Slots:    128,
		MaxPairs: 1_000_000_000_000,
	}
	wantFailure(t, req, KeyInfeasible)

	if !productOverflows(1_000_000_000_000, 1_000_000_000_000) {
		t.Fatal("1e12*1e12 must be reported as overflowing")
	}
	if productOverflows(1<<61, 2) {
		t.Fatal("2^62 fits in int64 and must not be flagged")
	}
	if !productOverflows(1<<62, 2) {
		t.Fatal("2^63 does not fit in int64 and must be flagged")
	}

	// Asymmetric overflow: feasibility is decided solely by the left ceil
	// factor, so the overflow machinery must not reject a feasible shape.
	feasible := Request{
		Left:     []KeyCount{{"k", 1_000_000_000_000}},
		Right:    []KeyCount{{"k", 10}},
		Slots:    128,
		MaxPairs: 1_000_000_000_000,
	}
	plan := mustPlan(t, feasible)
	if plan.TotalCells > 128 {
		t.Fatalf("cell count %d exceeds budget", plan.TotalCells)
	}
}

func TestBigIntegerCeiling(t *testing.T) {
	if got := ceilDiv(1_000_000_000_000, 128); got != 7_812_500_000 {
		t.Fatalf("ceil(1e12/128) = %d", got)
	}
	if got := ceilDiv(10, 3); got != 4 {
		t.Fatalf("ceil(10/3) = %d", got)
	}
	if got := ceilDiv(7, 7); got != 1 {
		t.Fatalf("ceil(7/7) = %d", got)
	}

	req := Request{
		Left:     []KeyCount{{"k", 10}},
		Right:    []KeyCount{{"k", 3}},
		Slots:    12,
		MaxPairs: 4,
	}
	plan := mustPlan(t, req)
	split := plan.Splits[0]
	worstLeft := ceilDiv(10, int64(split.R))
	worstRight := ceilDiv(3, int64(split.S))
	if productOverflows(worstLeft, worstRight) || worstLeft*worstRight > 4 {
		t.Fatalf("chosen (%d,%d) violates budget", split.R, split.S)
	}
}

func TestEmptySideAllocatesNothing(t *testing.T) {
	req := Request{
		Left: []KeyCount{
			{"both", 4},
			{"left-only", 9},
		},
		Right: []KeyCount{
			{"both", 3},
			{"right-only", 2},
		},
		Slots:    8,
		MaxPairs: 5,
	}
	plan := mustPlan(t, req)
	if len(plan.Splits) != 1 || plan.Splits[0].Key != "both" {
		t.Fatalf("only the two-sided key may get slots, got %#v", plan.Splits)
	}
	if plan.TotalCells != plan.Splits[0].Cells {
		t.Fatal("cell total inconsistent")
	}

	if _, err := plan.RouteLeft("left-only", 0); err == nil {
		t.Fatal("routing a key without cells must fail")
	}
	if _, err := plan.RouteRight("right-only", 0); err == nil {
		t.Fatal("routing a key without cells must fail")
	}

	empty := Request{Slots: 2, MaxPairs: 1}
	emptyPlan := mustPlan(t, empty)
	if len(emptyPlan.Splits) != 0 || emptyPlan.TotalCells != 0 ||
		emptyPlan.TotalTransferredRows != 0 {
		t.Fatalf("empty request must yield an empty plan, got %#v", emptyPlan)
	}
}

func TestNoFeasibleShapeReturnsStructuredReason(t *testing.T) {
	// P=1 forces r=s=1, whose cell holds all L*R pairs. B=1 is exceeded, so
	// the key has no feasible shape even though the budget is generous for
	// shapes that would need more slots.
	req := Request{
		Left:     []KeyCount{{"k", 2}, {"other", 1}},
		Right:    []KeyCount{{"k", 2}, {"other", 1}},
		Slots:    1,
		MaxPairs: 1,
	}
	plan, err := PlanSplit(req)
	if plan != nil {
		t.Fatalf("expected nil plan, got %#v", plan)
	}
	var failure *Failure
	if !errors.As(err, &failure) {
		t.Fatalf("expected *Failure, got %v", err)
	}
	if failure.Code != KeyInfeasible || failure.Key != "k" {
		t.Fatalf("expected key_infeasible for k, got code=%q key=%q", failure.Code, failure.Key)
	}
}
