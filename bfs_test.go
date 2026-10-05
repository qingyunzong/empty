package statever

import "testing"

func eventsOf(trace []Step) []int {
	out := make([]int, len(trace))
	for i, s := range trace {
		out[i] = s.Event
	}
	return out
}

func TestShortestViolationAndEventIDTieBreak(t *testing.T) {
	// Two shortest (length-2) traces to bad s3: [a,b] and [b,a]; a longer
	// one [b,b,b]. Event IDs: a=0 < b=1, so [a,b] must win.
	m := parse(t, `{
		"states": ["s0","s1","s2","s3"],
		"initial": "s0",
		"events": ["a","b"],
		"transitions": [
			{"from":"s0","event":"a","to":"s1"},
			{"from":"s1","event":"b","to":"s3"},
			{"from":"s0","event":"b","to":"s2"},
			{"from":"s2","event":"a","to":"s3"},
			{"from":"s2","event":"b","to":"s2"}
		],
		"bad": ["s3"],
		"budget": 10
	}`)
	res := BoundedCheck(m)
	if !res.Found() {
		t.Fatal("expected violation")
	}
	got := eventsOf(res.Violation)
	if len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Fatalf("got events %v, want [0 1] ([a,b] wins tie-break)", got)
	}
	if f := FormatTrace(m, res.Violation); f != "s0 -a-> s1 -b-> s3" {
		t.Fatalf("trace = %q", f)
	}
}

func TestBudgetBoundary(t *testing.T) {
	// Chain of 8 states: bad state at depth 7.
	found := BoundedCheck(chainModel(t, 8, 7))
	if !found.Found() || len(found.Violation) != 7 {
		t.Fatalf("budget 7: got found=%v len=%d, want len 7", found.Found(), len(found.Violation))
	}
	missed := BoundedCheck(chainModel(t, 8, 6))
	if missed.Found() {
		t.Fatalf("budget 6: unexpected violation of length %d", len(missed.Violation))
	}
	// Layered enumeration must agree at the boundary.
	lay := LayeredEnumerate(chainModel(t, 8, 6))
	if lay.MinBadDepth != -1 {
		t.Fatalf("layered MinBadDepth = %d, want -1 within budget 6", lay.MinBadDepth)
	}
	lay = LayeredEnumerate(chainModel(t, 8, 7))
	if lay.MinBadDepth != 7 {
		t.Fatalf("layered MinBadDepth = %d, want 7", lay.MinBadDepth)
	}
}

// TestLayeredCrossCheck verifies, independently of the BFS, that the
// reported counterexample length equals the first layer containing a bad
// state, for a spread of models and budgets.
func TestLayeredCrossCheck(t *testing.T) {
	models := []*Model{
		chainModel(t, 2, 10),
		chainModel(t, 5, 10),
		chainModel(t, 8, 10),
		chainModel(t, 8, 3),
		parse(t, `{"states":["s0","s1","s2"],"initial":"s0","events":["a","b"],
			"transitions":[
				{"from":"s0","event":"a","to":"s1"},
				{"from":"s1","event":"a","to":"s0"},
				{"from":"s0","event":"b","to":"s2"},
				{"from":"s2","event":"b","to":"s2"}],
			"bad":["s2"],"budget":10}`),
		parse(t, `{"states":["s0","s1"],"initial":"s0","events":["a"],
			"transitions":[{"from":"s0","event":"a","to":"s1"}],
			"bad":[],"budget":10}`),
	}
	for i, m := range models {
		bfs := BoundedCheck(m)
		lay := LayeredEnumerate(m)
		if bfs.Found() {
			if lay.MinBadDepth != len(bfs.Violation) {
				t.Fatalf("model %d: BFS len %d, layered depth %d",
					i, len(bfs.Violation), lay.MinBadDepth)
			}
			// No bad state may appear in any earlier layer.
			for d := 0; d < lay.MinBadDepth; d++ {
				for s := range lay.Layers[d] {
					if m.IsBad(s) {
						t.Fatalf("model %d: bad state in layer %d < %d", i, d, lay.MinBadDepth)
					}
				}
			}
		} else if lay.MinBadDepth != -1 {
			t.Fatalf("model %d: BFS found nothing, layered reports depth %d", i, lay.MinBadDepth)
		}
	}
}

func TestInitialStateBad(t *testing.T) {
	m := parse(t, `{"states":["s0"],"initial":"s0","events":["a"],
		"transitions":[],"bad":["s0"],"budget":10}`)
	res := BoundedCheck(m)
	if !res.Found() || len(res.Violation) != 0 {
		t.Fatalf("want empty violating trace, got %v", res.Violation)
	}
}
