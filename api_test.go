package formal

import (
	"errors"
	"testing"
)

func TestAliasesAndAccessors(t *testing.T) {
	calc := testTree(t)
	if calc.Root() != "root" {
		t.Fatalf("Root = %q", calc.Root())
	}
	got, err := calc.Compute(nil)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	if len(got) != len(calc.Nodes()) {
		t.Fatalf("Compute returned %d nodes, want %d", len(got), len(calc.Nodes()))
	}
	hold, err := calc.Admit(Request{ID: "alias", Node: "a1", Resources: Resources{"cpu": 1}})
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if _, err := calc.Cancel(hold.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	if _, err := calc.Reserve(Request{ID: "p", Node: "a1", Resources: Resources{"cpu": 2}}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	reclaimed, err := calc.Reclaim("root", Resources{"cpu": 1})
	if err != nil || reclaimed["cpu"] != 1 {
		t.Fatalf("Reclaim = %v, %v", reclaimed, err)
	}
	if _, err := calc.Release("p"); err != nil {
		t.Fatalf("Release p: %v", err)
	}
	if _, err := calc.Reserve(Request{ID: "q", Node: "a1", Priority: 1, Resources: Resources{"cpu": 1}}); err != nil {
		t.Fatalf("Reserve q: %v", err)
	}
	reclaimed, err = calc.PreemptFor("root", 5, Resources{"cpu": 10})
	if !errors.Is(err, ErrReclaimShortfall) || reclaimed["cpu"] != 1 {
		t.Fatalf("PreemptFor = %v, %v", reclaimed, err)
	}
}

func TestAllocateStateless(t *testing.T) {
	got, err := Allocate([]Node{
		{ID: "root", Limit: Resources{"cpu": 2}},
		{ID: "a", Parent: "root"},
		{ID: "b", Parent: "root"},
	}, []Demand{
		{Node: "a", Resources: Resources{"cpu": 1}},
		{Node: "b", Resources: Resources{"cpu": 1}},
	})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if got["root"]["cpu"] != 2 || got["a"]["cpu"] != 1 || got["b"]["cpu"] != 1 {
		t.Fatalf("Allocate = %v", got)
	}
}

func TestCheckDetectsCorruption(t *testing.T) {
	tests := []struct {
		name    string
		corrupt func(*Calculator)
	}{
		{
			name: "used exceeds limit",
			corrupt: func(calc *Calculator) {
				calc.used["root"]["cpu"] = 11
			},
		},
		{
			name: "used mismatch",
			corrupt: func(calc *Calculator) {
				calc.used["a"]["cpu"] = 99
			},
		},
		{
			name: "allocated mismatch",
			corrupt: func(calc *Calculator) {
				calc.allocated["root"]["cpu"] = 99
			},
		},
		{
			name: "negative grant",
			corrupt: func(calc *Calculator) {
				for _, entry := range calc.holds {
					entry.granted["cpu"] = -1
					return
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calc := testTree(t)
			if _, err := calc.Reserve(Request{ID: "h", Node: "a1", Resources: Resources{"cpu": 1}}); err != nil {
				t.Fatalf("Reserve: %v", err)
			}
			test.corrupt(calc)
			if err := calc.Check(); err == nil {
				t.Fatalf("Check did not detect corruption")
			}
		})
	}
}
