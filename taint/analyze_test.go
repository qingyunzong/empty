package taint

import (
	"reflect"
	"strings"
	"testing"
)

func mustParse(t *testing.T, js string) *Graph {
	t.Helper()
	g, err := Parse(strings.NewReader(js))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return g
}

func leakPaths(res *Result) []string {
	var out []string
	for _, l := range res.Leaks {
		out = append(out, l.PathString())
	}
	return out
}

// TestLinearLeak: source -> assign -> sink on a straight line.
func TestLinearLeak(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"user"},
	    {"id":"n2","kind":"assign","var":"q","uses":["user"]},
	    {"id":"n3","kind":"sink","var":"q","contexts":["sql"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3"}
	  ]
	}`)
	res := g.Analyze()
	if got := res.TaintAt("n3", "q"); !reflect.DeepEqual(got, []string{"sql"}) {
		t.Fatalf("TaintAt(n3,q) = %v, want [sql]", got)
	}
	want := []string{"n1:user[sql] -> n2:q[sql] -> n3:q[sql]"}
	if got := leakPaths(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("leak paths = %v, want %v", got, want)
	}
}

// TestSanitizeMatchingContext: sanitizing the sink's context blocks the leak.
func TestSanitizeMatchingContext(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"user"},
	    {"id":"n2","kind":"sanitize","var":"user","contexts":["sql"]},
	    {"id":"n3","kind":"sink","var":"user","contexts":["sql"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3"}
	  ]
	}`)
	res := g.Analyze()
	if len(res.Leaks) != 0 {
		t.Fatalf("expected no leaks, got %v", leakPaths(res))
	}
	if got := res.TaintAt("n3", "user"); len(got) != 0 {
		t.Fatalf("TaintAt(n3,user) = %v, want []", got)
	}
}

// TestSanitizeOtherContext: sanitization is only effective for the named
// contexts; taint for other contexts must survive.
func TestSanitizeOtherContext(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql", "html"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"user"},
	    {"id":"n2","kind":"sanitize","var":"user","contexts":["html"]},
	    {"id":"n3","kind":"sink","var":"user","contexts":["sql"]},
	    {"id":"n4","kind":"sink","var":"user","contexts":["html"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3"},
	    {"from":"n3","to":"n4"}
	  ]
	}`)
	res := g.Analyze()
	if got := res.TaintAt("n2", "user"); !reflect.DeepEqual(got, []string{"sql"}) {
		t.Fatalf("TaintAt(n2,user) = %v, want [sql]", got)
	}
	if len(res.Leaks) != 1 || res.Leaks[0].Sink != "n3" || res.Leaks[0].Ctx != "sql" {
		t.Fatalf("expected exactly one sql leak at n3, got %+v", res.Leaks)
	}
}

// TestImplicitFlow: a tainted branch condition taints variables assigned
// inside the branch, even from constants.
func TestImplicitFlow(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"flag"},
	    {"id":"n2","kind":"branch","uses":["flag"]},
	    {"id":"n3","kind":"assign","var":"x"},
	    {"id":"n4","kind":"nop"},
	    {"id":"n5","kind":"sink","var":"x","contexts":["sql"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3","label":"true"},
	    {"from":"n2","to":"n4","label":"false"},
	    {"from":"n3","to":"n4"},
	    {"from":"n4","to":"n5"}
	  ]
	}`)
	res := g.Analyze()
	if got := res.CtrlDeps["n2"]; !reflect.DeepEqual(got, []string{"n3"}) {
		t.Fatalf("CtrlDeps[n2] = %v, want [n3]", got)
	}
	if got := res.TaintAt("n3", "x"); !reflect.DeepEqual(got, []string{"sql"}) {
		t.Fatalf("TaintAt(n3,x) = %v, want [sql]", got)
	}
	want := []string{"n1:flag[sql] -> n2:flag[sql] -> n3:x[sql] -> n4:x[sql] -> n5:x[sql]"}
	if got := leakPaths(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("leak paths = %v, want %v", got, want)
	}
}

// TestLoopFixpoint: taint travels around a back edge; the analysis must
// iterate to the least fixpoint, and the recorded state expansion must
// grow monotonically and stabilize.
func TestLoopFixpoint(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"user"},
	    {"id":"n2","kind":"branch","uses":["cond"]},
	    {"id":"n3","kind":"assign","var":"z","uses":["user"]},
	    {"id":"n4","kind":"sink","var":"z","contexts":["sql"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3","label":"loop"},
	    {"from":"n3","to":"n2"},
	    {"from":"n2","to":"n4","label":"exit"}
	  ]
	}`)
	res := g.Analyze()

	// Pass 1: z tainted in the loop body but not yet at the header/sink.
	if got := res.Snapshot(0, "n3", "z"); !reflect.DeepEqual(got, []string{"sql"}) {
		t.Fatalf("pass 1 n3:z = %v, want [sql]", got)
	}
	if got := res.Snapshot(0, "n4", "z"); len(got) != 0 {
		t.Fatalf("pass 1 n4:z = %v, want [] (back edge not yet closed)", got)
	}
	// Pass 2: taint flows around the back edge to the header and sink.
	if got := res.Snapshot(1, "n4", "z"); !reflect.DeepEqual(got, []string{"sql"}) {
		t.Fatalf("pass 2 n4:z = %v, want [sql]", got)
	}
	// Least fixpoint: one more pass changes nothing, so 3 passes total.
	if res.Iterations != 3 {
		t.Fatalf("Iterations = %d, want 3", res.Iterations)
	}
	// State expansion is monotone: each snapshot is a subset of the next.
	for pass := 1; pass < res.Passes(); pass++ {
		for _, n := range g.Nodes {
			prev := res.history[pass-1][n.ID]
			cur := res.history[pass][n.ID]
			for v, ctxs := range prev {
				for c := range ctxs {
					if !cur[v][c] {
						t.Fatalf("non-monotone expansion at pass %d node %s: lost %s[%s]", pass, n.ID, v, c)
					}
				}
			}
		}
	}
	// Final pass is a fixpoint: last two snapshots are identical.
	last := res.history[res.Passes()-1]
	prev := res.history[res.Passes()-2]
	for _, n := range g.Nodes {
		if !varTaintEqual(last[n.ID], prev[n.ID]) {
			t.Fatalf("final pass not a fixpoint at node %s", n.ID)
		}
	}
	// The leak path goes through the header, the loop body, and back
	// around the header to the sink.
	want := []string{"n1:user[sql] -> n2:user[sql] -> n3:z[sql] -> n2:z[sql] -> n4:z[sql]"}
	if got := leakPaths(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("leak paths = %v, want %v", got, want)
	}
}

// TestDiamondTwoPaths: a diamond with taint on both arms yields one leak
// path per arm.
func TestDiamondTwoPaths(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"s"},
	    {"id":"n2","kind":"branch","uses":["c"]},
	    {"id":"n3","kind":"assign","var":"x","uses":["s"]},
	    {"id":"n4","kind":"assign","var":"x","uses":["s"]},
	    {"id":"n5","kind":"nop"},
	    {"id":"n6","kind":"sink","var":"x","contexts":["sql"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3","label":"true"},
	    {"from":"n2","to":"n4","label":"false"},
	    {"from":"n3","to":"n5"},
	    {"from":"n4","to":"n5"},
	    {"from":"n5","to":"n6"}
	  ]
	}`)
	res := g.Analyze()
	want := []string{
		"n1:s[sql] -> n2:s[sql] -> n3:x[sql] -> n5:x[sql] -> n6:x[sql]",
		"n1:s[sql] -> n2:s[sql] -> n4:x[sql] -> n5:x[sql] -> n6:x[sql]",
	}
	if got := leakPaths(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("leak paths = %v, want %v", got, want)
	}
}

// TestStrongUpdateKillsTaint: reassignment from constants clears taint.
func TestStrongUpdateKillsTaint(t *testing.T) {
	g := mustParse(t, `{
	  "contexts": ["sql"],
	  "entry": "n0",
	  "nodes": [
	    {"id":"n0","kind":"entry"},
	    {"id":"n1","kind":"source","var":"a"},
	    {"id":"n2","kind":"assign","var":"a"},
	    {"id":"n3","kind":"sink","var":"a","contexts":["sql"]}
	  ],
	  "edges": [
	    {"from":"n0","to":"n1"},
	    {"from":"n1","to":"n2"},
	    {"from":"n2","to":"n3"}
	  ]
	}`)
	res := g.Analyze()
	if len(res.Leaks) != 0 {
		t.Fatalf("expected no leaks after strong update, got %v", leakPaths(res))
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]string{
		"no contexts":     `{"entry":"n0","nodes":[{"id":"n0","kind":"entry"}]}`,
		"no nodes":        `{"contexts":["sql"],"entry":"n0"}`,
		"duplicate id":    `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"entry"},{"id":"a","kind":"exit"}]}`,
		"unknown kind":    `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"magic"}]}`,
		"missing var":     `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"source"}]}`,
		"sanitize no ctx": `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"sanitize","var":"x"}]}`,
		"branch no uses":  `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"branch"}]}`,
		"bad entry":       `{"contexts":["sql"],"entry":"zz","nodes":[{"id":"a","kind":"entry"}]}`,
		"bad edge":        `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"entry"}],"edges":[{"from":"a","to":"b"}]}`,
		"unknown context": `{"contexts":["sql"],"entry":"a","nodes":[{"id":"a","kind":"sink","var":"x","contexts":["nosql"]}]}`,
	}
	for name, js := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(js)); err == nil {
				t.Fatalf("expected parse error, got nil")
			}
		})
	}
}
