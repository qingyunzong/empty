package taint

import (
	"strings"
	"testing"
)

func mustLoad(t *testing.T, src string) *Program {
	t.Helper()
	p, err := Load(strings.NewReader(src))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return p
}

func analyze(t *testing.T, src string) *Analyzer {
	t.Helper()
	a := NewAnalyzer(mustLoad(t, src))
	a.Run()
	return a
}

// Small graph 1: linear data dependency source -> assign -> sink.
func TestLinearExplicitFlowLeaks(t *testing.T) {
	a := analyze(t, `{
	  "entry": "n1",
	  "nodes": [
	    {"id": "n1", "kind": "source", "var": "u", "next": "n2"},
	    {"id": "n2", "kind": "assign", "var": "q", "uses": ["u"], "next": "n3"},
	    {"id": "n3", "kind": "sink", "args": ["q"], "context": "sql"}
	  ]
	}`)
	leaks := a.Leaks()
	if len(leaks) != 1 {
		t.Fatalf("want 1 leak, got %v", leaks)
	}
	if leaks[0].SinkID != "n3" || leaks[0].Context != "sql" {
		t.Fatalf("unexpected leak %+v", leaks[0])
	}
	if len(leaks[0].Vars) != 1 || leaks[0].Vars[0] != "q" {
		t.Fatalf("leak should name variable q, got %v", leaks[0].Vars)
	}
	// State expansion must reproduce exactly one path n1 -> n2 -> n3.
	paths := a.ExpandPaths(2)
	if len(paths) != 1 {
		t.Fatalf("want 1 leak path, got %v", paths)
	}
	want := []string{"n1", "n2", "n3"}
	if strings.Join(paths[0].Nodes, ",") != strings.Join(want, ",") {
		t.Fatalf("path = %v, want %v", paths[0].Nodes, want)
	}
}

// Small graph 2: sanitizer declared for the sink's context blocks the leak.
func TestSanitizerMatchingContextBlocksLeak(t *testing.T) {
	a := analyze(t, `{
	  "entry": "n1",
	  "nodes": [
	    {"id": "n1", "kind": "source", "var": "u", "next": "n2"},
	    {"id": "n2", "kind": "sanitize", "var": "s", "arg": "u", "contexts": ["sql"], "next": "n3"},
	    {"id": "n3", "kind": "sink", "args": ["s"], "context": "sql"}
	  ]
	}`)
	if leaks := a.Leaks(); len(leaks) != 0 {
		t.Fatalf("want no leaks, got %v", leaks)
	}
	if paths := a.ExpandPaths(2); len(paths) != 0 {
		t.Fatalf("want no leak paths, got %v", paths)
	}
}

// Small graph 3: sanitizer only valid for "html" does not protect the
// "sql" sink - cleaning is context-specific.
func TestSanitizerWrongContextStillLeaks(t *testing.T) {
	a := analyze(t, `{
	  "entry": "n1",
	  "nodes": [
	    {"id": "n1", "kind": "source", "var": "u", "next": "n2"},
	    {"id": "n2", "kind": "sanitize", "var": "s", "arg": "u", "contexts": ["html"], "next": "n3"},
	    {"id": "n3", "kind": "sink", "args": ["s"], "context": "sql"}
	  ]
	}`)
	if leaks := a.Leaks(); len(leaks) != 1 {
		t.Fatalf("want 1 leak, got %v", leaks)
	}
	// The residual taint after the wrong-context sanitizer must still
	// contain sql (and default), but not html.
	res := a.In["n3"].Vars["s"]
	if !res["sql"] || !res["default"] || res["html"] {
		t.Fatalf("residual taint = %v, want sql+default without html", res)
	}
}

// Small graph 4: taint propagates through a branch condition (implicit
// flow) into an assignment on the branch.
func TestImplicitFlowThroughBranch(t *testing.T) {
	a := analyze(t, `{
	  "entry": "n1",
	  "nodes": [
	    {"id": "n1", "kind": "source", "var": "u", "next": "n2"},
	    {"id": "n2", "kind": "branch", "uses": ["u"], "then": "n3", "else": "n4"},
	    {"id": "n3", "kind": "assign", "var": "v", "uses": ["w"], "next": "n5"},
	    {"id": "n4", "kind": "assign", "var": "v", "uses": ["w"], "next": "n5"},
	    {"id": "n5", "kind": "sink", "args": ["v"], "context": "sql"}
	  ]
	}`)
	leaks := a.Leaks()
	if len(leaks) != 1 {
		t.Fatalf("want 1 leak via implicit flow, got %v", leaks)
	}
	if !leaks[0].ViaCond {
		t.Fatalf("leak should be flagged as condition-mediated: %+v", leaks[0])
	}
	// Expansion yields one leaking path per branch arm.
	paths := a.ExpandPaths(2)
	if len(paths) != 2 {
		t.Fatalf("want 2 leak paths (then/else), got %d: %v", len(paths), paths)
	}
}

// Small graph 5: a loop carries taint around the back edge; the analysis
// must reach the least fixed point and the bounded expansion must find the
// leaking path through the loop.
func TestLoopFixedPoint(t *testing.T) {
	a := analyze(t, `{
	  "entry": "n1",
	  "nodes": [
	    {"id": "n1", "kind": "source", "var": "x", "next": "n2"},
	    {"id": "n2", "kind": "branch", "uses": ["x"], "then": "n3", "else": "n5"},
	    {"id": "n3", "kind": "assign", "var": "y", "uses": ["x"], "next": "n4"},
	    {"id": "n4", "kind": "assign", "var": "x", "uses": ["y"], "next": "n2"},
	    {"id": "n5", "kind": "sink", "args": ["x"], "context": "sql"}
	  ]
	}`)
	// Fixed point: y is tainted at n3 even though it is only reachable
	// through the loop back edge into n2.
	if !a.In["n3"].Vars["x"]["sql"] {
		t.Fatalf("fixed point lost taint on x at n3: %v", a.In["n3"])
	}
	if !a.In["n5"].Vars["x"]["sql"] {
		t.Fatalf("fixed point lost taint on x at sink: %v", a.In["n5"])
	}
	if leaks := a.Leaks(); len(leaks) != 1 {
		t.Fatalf("want 1 leak, got %v", leaks)
	}
	// With unroll=1 the loop body is entered once and the sink path exists.
	paths := a.ExpandPaths(1)
	if len(paths) != 1 {
		t.Fatalf("unroll=1: want 1 leak path, got %v", paths)
	}
	// With unroll=2 the path that iterates the loop once before exiting
	// also appears.
	paths2 := a.ExpandPaths(2)
	if len(paths2) != 2 {
		t.Fatalf("unroll=2: want 2 leak paths, got %v", paths2)
	}
}

// Small graph 6: may-analysis joins taint from a single branch arm.
func TestJoinKeepsMayTaint(t *testing.T) {
	a := analyze(t, `{
	  "entry": "n1",
	  "nodes": [
	    {"id": "n1", "kind": "branch", "uses": ["c"], "then": "n2", "else": "n3"},
	    {"id": "n2", "kind": "source", "var": "v", "next": "n4"},
	    {"id": "n3", "kind": "assign", "var": "v", "uses": ["clean"], "next": "n4"},
	    {"id": "n4", "kind": "sink", "args": ["v"], "context": "sql"}
	  ]
	}`)
	if leaks := a.Leaks(); len(leaks) != 1 {
		t.Fatalf("want 1 leak (may-taint survives join), got %v", leaks)
	}
}

// Invalid programs are rejected.
func TestValidation(t *testing.T) {
	for _, src := range []string{
		`{"entry": "nope", "nodes": []}`,
		`{"entry": "a", "nodes": [{"id": "a", "kind": "assign", "var": "x", "next": "ghost"}]}`,
		`{"entry": "a", "nodes": [{"id": "a", "kind": "wat"}]}`,
		`{"entry": "a", "nodes": [{"id": "a", "kind": "assign"}, {"id": "a", "kind": "assign"}]}`,
	} {
		if _, err := Load(strings.NewReader(src)); err == nil {
			t.Fatalf("expected error for %s", src)
		}
	}
}
