package formal

import (
	"errors"
	"reflect"
	"testing"
)

func priorityTree(t *testing.T) *Calculator {
	t.Helper()
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 100}},
		{ID: "low1", Parent: "root", Priority: 1},
		{ID: "low2", Parent: "root", Priority: 1},
		{ID: "mid", Parent: "root", Priority: 5},
		{ID: "high", Parent: "root", Priority: 9},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	return calc
}

func mustReserve(t *testing.T, calc *Calculator, id, node string, priority, cpu int64) {
	t.Helper()
	if _, err := calc.Reserve(Request{
		ID:        id,
		Node:      node,
		Priority:  priority,
		Resources: Resources{"cpu": cpu},
	}); err != nil {
		t.Fatalf("Reserve(%s): %v", id, err)
	}
}

func cpuOf(hold Hold) int64 {
	return hold.Granted["cpu"]
}

func TestPreemptLowestPriorityFirstAndConserved(t *testing.T) {
	calc := priorityTree(t)
	mustReserve(t, calc, "low1", "low1", 1, 10)
	mustReserve(t, calc, "low2", "low2", 1, 10)
	mustReserve(t, calc, "mid", "mid", 5, 10)
	mustReserve(t, calc, "high", "high", 9, 10)

	reclaimed, err := calc.Preempt("root", Resources{"cpu": 25})
	if err != nil {
		t.Fatalf("Preempt: %v", err)
	}
	if reclaimed["cpu"] != 25 {
		t.Fatalf("reclaimed = %d, want 25", reclaimed["cpu"])
	}
	low1, _ := calc.Get("low1")
	low2, _ := calc.Get("low2")
	mid, _ := calc.Get("mid")
	high, _ := calc.Get("high")
	if cpuOf(low1) != 0 || cpuOf(low2) != 0 {
		t.Fatalf("low priority holds not fully reclaimed: %d/%d", cpuOf(low1), cpuOf(low2))
	}
	if cpuOf(mid) != 5 {
		t.Fatalf("mid priority hold = %d, want 5", cpuOf(mid))
	}
	if cpuOf(high) != 10 {
		t.Fatalf("high priority hold = %d, want 10", cpuOf(high))
	}
	usage, _ := calc.NodeUsage("root")
	if usage.Used["cpu"] != 15 {
		t.Fatalf("root used = %d, want 15", usage.Used["cpu"])
	}
	if err := calc.Check(); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

func TestPreemptProportionalWithinPriorityAndStable(t *testing.T) {
	calc := priorityTree(t)
	mustReserve(t, calc, "a", "low1", 1, 3)
	mustReserve(t, calc, "b", "low2", 1, 6)

	reclaimed, err := calc.Preempt("root", Resources{"cpu": 4})
	if err != nil {
		t.Fatalf("Preempt: %v", err)
	}
	a, _ := calc.Get("a")
	b, _ := calc.Get("b")
	gotA, gotB := 3-cpuOf(a), 6-cpuOf(b)
	if gotA+gotB != reclaimed["cpu"] || reclaimed["cpu"] != 4 {
		t.Fatalf("reclaimed %d split %d+%d", reclaimed["cpu"], gotA, gotB)
	}
	// Proportional split of 4 over 3:6 is 1:3 after largest remainder.
	if gotA != 1 || gotB != 3 {
		t.Fatalf("proportional reclaim = %d/%d, want 1/3", gotA, gotB)
	}
}

func TestPreemptTieBreakIsStableAcrossCreationOrder(t *testing.T) {
	run := func(first, second string) map[string]int64 {
		calc := priorityTree(t)
		mustReserve(t, calc, first, "low1", 1, 3)
		mustReserve(t, calc, second, "low2", 1, 3)
		reclaimed, err := calc.Preempt("root", Resources{"cpu": 5})
		if err != nil {
			t.Fatalf("Preempt: %v", err)
		}
		if reclaimed["cpu"] != 5 {
			t.Fatalf("reclaimed = %d, want 5", reclaimed["cpu"])
		}
		a, _ := calc.Get("a")
		b, _ := calc.Get("b")
		return map[string]int64{
			"a": 3 - cpuOf(a),
			"b": 3 - cpuOf(b),
		}
	}
	firstOrder := run("a", "b")
	secondOrder := run("b", "a")
	if !reflect.DeepEqual(firstOrder, secondOrder) {
		t.Fatalf("reclaim depends on creation order: %v vs %v", firstOrder, secondOrder)
	}
	if firstOrder["a"] != 3 || firstOrder["b"] != 2 {
		t.Fatalf("stable tie-break = %v, want a=3 b=2", firstOrder)
	}
}

func TestPreemptBelowLeavesEqualAndHigherPriorities(t *testing.T) {
	calc := priorityTree(t)
	mustReserve(t, calc, "low", "low1", 1, 5)
	mustReserve(t, calc, "equal", "mid", 5, 5)
	mustReserve(t, calc, "high", "high", 9, 5)

	reclaimed, err := calc.PreemptBelow("root", 5, Resources{"cpu": 10})
	if !errors.Is(err, ErrReclaimShortfall) {
		t.Fatalf("error = %v, want ErrReclaimShortfall", err)
	}
	if reclaimed["cpu"] != 5 {
		t.Fatalf("reclaimed = %d, want 5", reclaimed["cpu"])
	}
	equal, _ := calc.Get("equal")
	high, _ := calc.Get("high")
	if cpuOf(equal) != 5 || cpuOf(high) != 5 {
		t.Fatalf("equal/high changed: %d/%d", cpuOf(equal), cpuOf(high))
	}
}

func TestPreemptShortfallReportsMissing(t *testing.T) {
	calc := priorityTree(t)
	mustReserve(t, calc, "low", "low1", 1, 5)
	reclaimed, err := calc.Preempt("root", Resources{"cpu": 8})
	if !errors.Is(err, ErrReclaimShortfall) {
		t.Fatalf("error = %v, want ErrReclaimShortfall", err)
	}
	var shortfall *ShortfallError
	if !errors.As(err, &shortfall) {
		t.Fatalf("error type = %T", err)
	}
	if shortfall.Missing["cpu"] != 3 {
		t.Fatalf("missing = %d, want 3", shortfall.Missing["cpu"])
	}
	if reclaimed["cpu"] != 5 {
		t.Fatalf("reclaimed = %d, want 5", reclaimed["cpu"])
	}
	if len(calc.Holds()) != 0 {
		t.Fatalf("hold should be empty after full reclaim: %+v", calc.Holds())
	}
}

func TestPreemptOnlySubtree(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 100}},
		{ID: "a", Parent: "root"},
		{ID: "a1", Parent: "a"},
		{ID: "b", Parent: "root"},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	mustReserve(t, calc, "a", "a1", 1, 5)
	mustReserve(t, calc, "b", "b", 1, 5)
	reclaimed, err := calc.Preempt("a", Resources{"cpu": 10})
	if !errors.Is(err, ErrReclaimShortfall) {
		t.Fatalf("error = %v, want ErrReclaimShortfall", err)
	}
	if reclaimed["cpu"] != 5 {
		t.Fatalf("reclaimed = %d, want 5", reclaimed["cpu"])
	}
	if _, ok := calc.Get("b"); !ok {
		t.Fatalf("hold outside subtree was reclaimed")
	}
}

func TestPreemptMultipleResources(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 100, "mem": 100}},
		{ID: "job", Parent: "root", Priority: 1},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	if _, err := calc.Reserve(Request{
		ID:        "job",
		Node:      "job",
		Resources: Resources{"cpu": 10, "mem": 8},
	}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	reclaimed, err := calc.Preempt("root", Resources{"cpu": 4, "mem": 3})
	if err != nil {
		t.Fatalf("Preempt: %v", err)
	}
	if !reflect.DeepEqual(reclaimed, Resources{"cpu": 4, "mem": 3}) {
		t.Fatalf("reclaimed = %v", reclaimed)
	}
	hold, _ := calc.Get("job")
	if !reflect.DeepEqual(hold.Granted, Resources{"cpu": 6, "mem": 5}) {
		t.Fatalf("remaining = %v", hold.Granted)
	}
}
