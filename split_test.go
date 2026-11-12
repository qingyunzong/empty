package dataeng

import (
	"fmt"
	"math/rand"
	"testing"
)

func mustPlan(t *testing.T, req Request) *Plan {
	t.Helper()
	plan, err := PlanSplit(req)
	if err != nil {
		t.Fatalf("PlanSplit returned error: %v", err)
	}
	if plan == nil {
		t.Fatal("PlanSplit returned nil plan without error")
	}
	if err := plan.Verify(); err != nil {
		t.Fatalf("plan verification failed: %v", err)
	}
	return plan
}

func assertMatchesOracle(t *testing.T, req Request) {
	t.Helper()
	left := map[string]int64{}
	right := map[string]int64{}
	for _, row := range req.Left {
		left[row.Key] = row.Count
	}
	for _, row := range req.Right {
		right[row.Key] = row.Count
	}
	want := oraclePlan(left, right, req.Slots, req.MaxPairs)

	if !want.ok {
		wantFailure(t, req, want.code)
		return
	}

	plan := mustPlan(t, req)
	if len(plan.Splits) != len(want.seq) {
		t.Fatalf("split count: got %d want %d", len(plan.Splits), len(want.seq))
	}

	slotStart := 0
	var gotTransfer int64
	for i, split := range plan.Splits {
		wantPair := want.seq[i]
		if split.R != wantPair.r || split.S != wantPair.s {
			t.Fatalf("key %q: got (r,s)=(%d,%d), want (%d,%d)",
				split.Key, split.R, split.S, wantPair.r, wantPair.s)
		}
		if split.Cells != split.R*split.S {
			t.Fatalf("key %q: bad cell count %d", split.Key, split.Cells)
		}
		if split.SlotStart != slotStart {
			t.Fatalf("key %q: slot start %d, want %d", split.Key, split.SlotStart, slotStart)
		}
		slotStart += split.Cells
		gotTransfer += left[split.Key]*int64(split.S) + right[split.Key]*int64(split.R)
	}
	if plan.TotalCells != want.cells {
		t.Fatalf("total cells: got %d want %d", plan.TotalCells, want.cells)
	}
	if plan.TotalTransferredRows != want.transfer || gotTransfer != want.transfer {
		t.Fatalf("transfer: plan=%d recomputed=%d want=%d",
			plan.TotalTransferredRows, gotTransfer, want.transfer)
	}
}

func TestExhaustiveSmallInstances(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	names := []string{"a", "b", "c", "d", "A", "\u00e9", "k7"}
	for iter := 0; iter < 2000; iter++ {
		n := rng.Intn(5)
		req := Request{
			Slots:    1 + rng.Intn(8),
			MaxPairs: int64(1 + rng.Intn(30)),
		}
		used := map[string]bool{}
		for i := 0; i < n; i++ {
			name := names[rng.Intn(len(names))]
			if used[name] {
				continue
			}
			used[name] = true
			l := int64(rng.Intn(11))
			r := int64(rng.Intn(11))
			if l > 0 {
				req.Left = append(req.Left, KeyCount{name, l})
			}
			if r > 0 {
				req.Right = append(req.Right, KeyCount{name, r})
			}
		}
		assertMatchesOracle(t, req)
	}
}

func TestFixedInstancesAgainstOracle(t *testing.T) {
	cases := []Request{
		{
			Left:     []KeyCount{{"k", 2}, {"q", 3}},
			Right:    []KeyCount{{"k", 2}, {"q", 1}},
			Slots:    4,
			MaxPairs: 3,
		},
		{
			Left:     []KeyCount{{"k", 1}},
			Right:    []KeyCount{{"k", 1}},
			Slots:    1,
			MaxPairs: 1,
		},
		{
			Left:     []KeyCount{{"k", 10}, {"j", 7}},
			Right:    []KeyCount{{"k", 10}, {"j", 4}, {"z", 2}},
			Slots:    8,
			MaxPairs: 12,
		},
		{
			Left:     []KeyCount{{"only-left", 5}},
			Right:    []KeyCount{{"only-right", 5}},
			Slots:    4,
			MaxPairs: 10,
		},
	}
	for i, req := range cases {
		t.Run(fmt.Sprintf("case-%d", i), func(t *testing.T) {
			assertMatchesOracle(t, req)
		})
	}
}
