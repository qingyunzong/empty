package policy

import (
	"fmt"
	"sync"
	"testing"
)

func engineRuleSets() (v1, v2 []Rule) {
	v1 = []Rule{
		{ID: "r1", When: Pred{Path: []string{"spec", "replicas"}, Op: OpGt, Value: 2}, Reason: "v1: too many replicas"},
		{ID: "r2", When: Selector{MatchLabels: map[string]string{"app": "a"}}, Reason: "v1: app=a denied"},
	}
	v2 = []Rule{
		{ID: "r1", When: Pred{Path: []string{"spec", "replicas"}, Op: OpGte, Value: 1}, Reason: "v2: any replicas denied"},
		{ID: "r3", When: Quantifier{Kind: Exists, Path: []string{"spec", "containers"},
			Item: Pred{Path: []string{"name"}, Op: OpEq, Value: "web"}}, Reason: "v2: web container denied"},
	}
	return v1, v2
}

// TestHotSwapConsistency interleaves rule hot-swaps with evaluations and
// checks that every observed decision equals the naive re-evaluation of
// either the whole old or the whole new rule set, never a mix.
func TestHotSwapConsistency(t *testing.T) {
	v1, v2 := engineRuleSets()
	engine, err := NewEngine(v1)
	if err != nil {
		t.Fatal(err)
	}
	objects := objectSpace()
	const workers = 8
	var wg sync.WaitGroup
	stop := make(chan struct{})
	errs := make(chan string, workers)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				obj := objects[(i+w)%len(objects)]
				got := engine.EvaluateAll(obj)
				want1 := naiveDecision(v1, obj)
				want2 := naiveDecision(v2, obj)
				if !decisionsEqual(got, want1) && !decisionsEqual(got, want2) {
					errs <- fmt.Sprintf("worker %d object %d: decision %+v matches neither rule set", w, i, got)
					return
				}
			}
		}(w)
	}
	for i := 0; i < 200; i++ {
		if i%2 == 0 {
			if err := engine.Update(v2); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := engine.Update(v1); err != nil {
				t.Fatal(err)
			}
		}
	}
	close(stop)
	wg.Wait()
	select {
	case msg := <-errs:
		t.Fatal(msg)
	default:
	}
}

func decisionsEqual(a, b Decision) bool {
	if a.Allowed != b.Allowed || len(a.Reasons) != len(b.Reasons) {
		return false
	}
	for i := range a.Reasons {
		if a.Reasons[i] != b.Reasons[i] {
			return false
		}
	}
	return true
}

// TestCompiledPlanNotPolluted mutates the caller's rule data after
// compilation (nested maps, slices, comparison values) and verifies the
// compiled plan is unaffected.
func TestCompiledPlanNotPolluted(t *testing.T) {
	labels := map[string]string{"app": "a"}
	inValues := []any{"gold", "silver"}
	item := Pred{Path: []string{"name"}, Op: OpEq, Value: "web"}
	rules := []Rule{
		{ID: "r1", When: Selector{MatchLabels: labels}, Reason: "sel"},
		{ID: "r2", When: Pred{Path: []string{"spec", "tier"}, Op: OpIn, Value: inValues}, Reason: "in"},
		{ID: "r3", When: Quantifier{Kind: Exists, Path: []string{"spec", "containers"}, Item: item}, Reason: "quant"},
	}
	plan, err := Compile(rules)
	if err != nil {
		t.Fatal(err)
	}
	objects := objectSpace()
	before := make([]Decision, len(objects))
	for i, obj := range objects {
		before[i] = plan.EvaluateAll(obj)
	}
	labels["app"] = "POLLUTED"
	labels["extra"] = "POLLUTED"
	inValues[0] = "POLLUTED"
	item.Value = "POLLUTED"
	item.Path[0] = "POLLUTED"
	rules[0].When.(Selector).MatchLabels["app"] = "POLLUTED"
	for i, obj := range objects {
		if got := plan.EvaluateAll(obj); !decisionsEqual(got, before[i]) {
			t.Fatalf("object %d: plan polluted by caller mutation: got %+v want %+v", i, got, before[i])
		}
	}
}

// TestFailedUpdateKeepsOldPlan ensures a failed recompile leaves the
// serving plan untouched.
func TestFailedUpdateKeepsOldPlan(t *testing.T) {
	v1, _ := engineRuleSets()
	engine, err := NewEngine(v1)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Update([]Rule{{ID: "broken"}}); err == nil {
		t.Fatal("expected compile error")
	}
	obj := map[string]any{"spec": map[string]any{"replicas": 5}}
	got := engine.EvaluateAll(obj)
	want := naiveDecision(v1, obj)
	if !decisionsEqual(got, want) {
		t.Fatalf("old plan must keep serving after failed update: got %+v want %+v", got, want)
	}
}
