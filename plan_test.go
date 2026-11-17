package formal

import (
	"errors"
	"reflect"
	"testing"
)

func leaf(name string, g int64) *Node { return &Node{Name: name, Guarantee: g} }

func intern(name string, g int64, children ...*Node) *Node {
	return &Node{Name: name, Guarantee: g, Children: children}
}

func job(id, queue string, prio int, units int64, seq uint64) Job {
	return Job{ID: id, Queue: queue, Priority: prio, Members: 1, UnitsPerMember: units, Seq: seq, Preemptible: true}
}

func running(j Job, work int64) Job {
	j.Running = true
	j.CompletedWork = work
	return j
}

func ids(jobs []Job) []string {
	out := []string{}
	for _, j := range jobs {
		out = append(out, j.ID)
	}
	return out
}

func idSet(jobs []Job) map[string]bool {
	out := map[string]bool{}
	for _, j := range jobs {
		out[j.ID] = true
	}
	return out
}

func mustPlan(t *testing.T, in Input) *Result {
	t.Helper()
	p, err := Plan(in, nil)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	return p
}

// A queue that lent out its idle guarantee reclaims it on demand; the victims
// are chosen to minimize lost completed work.
func TestGuaranteeReclaimMinimizesLostWork(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 5), leaf("b", 5))}
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs: []Job{
			running(job("b1", "b", 1, 4, 1), 100),
			running(job("b2", "b", 1, 4, 2), 1),
			running(job("b3", "b", 1, 2, 3), 0),
			job("a1", "a", 5, 5, 4),
		},
	}
	plan := mustPlan(t, in)
	if got := idSet(plan.Allocated); !reflect.DeepEqual(got, map[string]bool{"a1": true, "b1": true}) {
		t.Fatalf("allocated = %v, want a1+b1", got)
	}
	if got := idSet(plan.Preempt); !reflect.DeepEqual(got, map[string]bool{"b2": true, "b3": true}) {
		t.Fatalf("preempt = %v, want b2+b3 (least completed work)", got)
	}
	if got := ids(plan.Start); !reflect.DeepEqual(got, []string{"a1"}) {
		t.Fatalf("start = %v, want [a1]", got)
	}
	if plan.Score.KeptWork != 100 {
		t.Fatalf("kept work = %d, want 100", plan.Score.KeptWork)
	}
}

// A higher-priority pending job preempts a lower-priority running job in the
// same queue even when the victim holds completed work.
func TestPriorityPreemptionWithinQueue(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 10))}
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs: []Job{
			running(job("low", "a", 1, 6, 1), 50),
			job("high", "a", 9, 6, 2),
		},
	}
	plan := mustPlan(t, in)
	if got := ids(plan.Preempt); !reflect.DeepEqual(got, []string{"low"}) {
		t.Fatalf("preempt = %v, want [low]", got)
	}
	if got := ids(plan.Start); !reflect.DeepEqual(got, []string{"high"}) {
		t.Fatalf("start = %v, want [high]", got)
	}
}

// Equal-priority competition is stable: the earlier-arriving incumbent is
// never reshuffled for an identical later job.
func TestStableFairnessKeepsIncumbent(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 10))}
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs: []Job{
			running(job("old", "a", 1, 6, 1), 0),
			job("new", "a", 1, 6, 2),
		},
	}
	plan := mustPlan(t, in)
	if len(plan.Preempt) != 0 || len(plan.Start) != 0 {
		t.Fatalf("expected no churn, got preempt=%v start=%v", ids(plan.Preempt), ids(plan.Start))
	}
}

// The planner solves gang packing optimally instead of greedily: two 5-unit
// gangs beat one 6-unit gang that canonical first-fit would pick.
func TestGangPackingIsOptimal(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 4))}
	big := job("big", "a", 1, 2, 1)
	big.Members = 3 // 6 units, atomic
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs: []Job{
			big,
			job("g1", "a", 1, 5, 2),
			job("g2", "a", 1, 5, 3),
		},
	}
	plan := mustPlan(t, in)
	if got := idSet(plan.Allocated); !reflect.DeepEqual(got, map[string]bool{"g1": true, "g2": true}) {
		t.Fatalf("allocated = %v, want g1+g2", got)
	}
}

// Idle capacity is borrowed within a subtree before crossing branches: B's
// extra demand beats C's extra demand for the units A left idle under P1.
func TestHierarchyBorrowingLocality(t *testing.T) {
	tree := &Tree{Root: intern("root", 10,
		intern("p1", 5, leaf("a", 3), leaf("b", 2)),
		intern("p2", 5, leaf("c", 5)),
	)}
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs: []Job{
			job("b1", "p1/b", 1, 2, 1),
			job("b2", "p1/b", 1, 3, 2),
			job("c1", "p2/c", 1, 5, 3),
			job("c2", "p2/c", 1, 4, 4),
		},
	}
	plan := mustPlan(t, in)
	want := map[string]bool{"b1": true, "b2": true, "c1": true}
	if got := idSet(plan.Allocated); !reflect.DeepEqual(got, want) {
		t.Fatalf("allocated = %v, want %v", got, want)
	}
}

// Non-preemptible running jobs are kept even against higher priorities.
func TestNonPreemptibleKept(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 10))}
	x := running(job("x", "a", 1, 8, 1), 10)
	x.Preemptible = false
	in := Input{
		Capacity: 10,
		Tree:     tree,
		Jobs:     []Job{x, job("h", "a", 9, 5, 2)},
	}
	plan := mustPlan(t, in)
	if !idSet(plan.Allocated)["x"] {
		t.Fatalf("non-preemptible job was dropped: %v", ids(plan.Allocated))
	}
	if len(plan.Start) != 0 {
		t.Fatalf("no capacity for h, got start=%v", ids(plan.Start))
	}
}

func TestNonPreemptibleOverflow(t *testing.T) {
	tree := &Tree{Root: intern("root", 10, leaf("a", 10))}
	x := running(job("x", "a", 1, 11, 1), 0)
	x.Preemptible = false
	_, err := Plan(Input{Capacity: 10, Tree: tree, Jobs: []Job{x}}, nil)
	if !errors.Is(err, ErrOverCapacity) {
		t.Fatalf("err = %v, want ErrOverCapacity", err)
	}
}

func TestEmptyInput(t *testing.T) {
	tree := &Tree{Root: intern("root", 4, leaf("a", 4))}
	plan := mustPlan(t, Input{Capacity: 4, Tree: tree})
	if len(plan.Allocated) != 0 || len(plan.Start) != 0 || len(plan.Preempt) != 0 {
		t.Fatalf("expected empty plan, got %+v", plan)
	}
}

func TestValidationErrors(t *testing.T) {
	good := &Tree{Root: intern("root", 4, leaf("a", 4))}
	cases := []struct {
		name string
		in   Input
	}{
		{"root guarantee exceeds capacity", Input{Capacity: 3, Tree: good}},
		{"unknown queue", Input{Capacity: 4, Tree: good, Jobs: []Job{job("j", "nope", 1, 1, 1)}}},
		{"duplicate job", Input{Capacity: 4, Tree: good, Jobs: []Job{job("j", "a", 1, 1, 1), job("j", "a", 1, 1, 2)}}},
		{"bad gang", Input{Capacity: 4, Tree: good, Jobs: []Job{{ID: "j", Queue: "a", Members: 0, UnitsPerMember: 1}}}},
		{"children exceed parent", Input{Capacity: 10, Tree: &Tree{Root: intern("root", 10, leaf("a", 6), leaf("b", 6))}}},
	}
	for _, tc := range cases {
		if _, err := Plan(tc.in, nil); err == nil {
			t.Fatalf("%s: expected error", tc.name)
		}
	}
}
