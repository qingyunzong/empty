package main

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func load(t *testing.T, text string) *LogSet {
	t.Helper()
	set := NewLogSet()
	if err := ParseLog(strings.NewReader(text), set); err != nil {
		t.Fatalf("ParseLog: %v", err)
	}
	return set
}

func TestConsistentWithCrashedShortPrefix(t *testing.T) {
	set := load(t, `
status n1 ok
status n2 ok
status n3 crashed
entry n1 a
entry n1 b
entry n1 c
entry n2 a
entry n2 b
entry n2 c
entry n3 a
`)
	c, found := FullCheck(set)
	if found {
		t.Fatalf("expected consistent, got conflict %v", c)
	}
	rep := Report(set, c, found)
	if !strings.Contains(rep, "OK") {
		t.Fatalf("report should say OK, got:\n%s", rep)
	}
	if !strings.Contains(rep, "n3: status=crashed entries=1") {
		t.Fatalf("report should show crashed node's short prefix, got:\n%s", rep)
	}
}

func TestUnknownStatusNotTreatedAsFault(t *testing.T) {
	// Unknown-status node with a short prefix: consistent, and the report
	// must not label it crashed or faulty.
	set := load(t, `
status n1 ok
status n2 unknown
entry n1 a
entry n1 b
entry n2 a
`)
	c, found := FullCheck(set)
	if found {
		t.Fatalf("unknown short prefix must not be a fault, got %v", c)
	}
	rep := Report(set, c, found)
	if !strings.Contains(rep, "n2: status=unknown") {
		t.Fatalf("report must keep status=unknown, got:\n%s", rep)
	}
	if strings.Contains(rep, "fault") || strings.Contains(rep, "crashed entries=1") {
		t.Fatalf("unknown node must not be reported as faulty, got:\n%s", rep)
	}
}

func TestEarliestConflictAndTwoSources(t *testing.T) {
	set := load(t, `
entry n1 a
entry n1 b
entry n1 x
entry n2 a
entry n2 b
entry n2 y
entry n3 a
entry n3 b
entry n3 x
`)
	c, found := FullCheck(set)
	if !found {
		t.Fatal("expected conflict")
	}
	if c.Index != 2 {
		t.Fatalf("want earliest index 2, got %d", c.Index)
	}
	// Two sources reported, deterministic tie-break: n1 < n2.
	if c.NodeA != "n1" || c.NodeB != "n2" {
		t.Fatalf("want sources n1,n2 got %s,%s", c.NodeA, c.NodeB)
	}
	if c.ValueA != "x" || c.ValueB != "y" {
		t.Fatalf("want values x,y got %q,%q", c.ValueA, c.ValueB)
	}
	rep := Report(set, c, found)
	if !strings.Contains(rep, "sources: n1, n2") {
		t.Fatalf("report must name both sources, got:\n%s", rep)
	}
}

func TestCrashedNodeDivergenceStillReported(t *testing.T) {
	// Crash excuses a short prefix, never a diverging entry.
	set := load(t, `
status n2 crashed
entry n1 a
entry n1 b
entry n2 a
entry n2 z
`)
	c, found := FullCheck(set)
	if !found || c.Index != 1 || c.ValueB != "z" {
		t.Fatalf("crashed node's divergence must be reported, got %v found=%v", c, found)
	}
}

func TestUnknownNodeDivergenceStillReported(t *testing.T) {
	set := load(t, `
status n3 unknown
entry n1 a
entry n3 b
`)
	c, found := FullCheck(set)
	if !found || c.Index != 0 {
		t.Fatalf("unknown node's divergence must be reported, got %v found=%v", c, found)
	}
}

func TestParseErrors(t *testing.T) {
	for _, text := range []string{
		"bogus x y\n",
		"status n1\n",
		"status n1 sleepy\n",
		"entry n1\n",
	} {
		if err := ParseLog(strings.NewReader(text), NewLogSet()); err == nil {
			t.Fatalf("want parse error for %q", text)
		}
	}
	// Unknown status must not be silently accepted as a fault state.
	if err := ParseLog(strings.NewReader("status n1 unknown\n"), NewLogSet()); err != nil {
		t.Fatalf("explicit unknown status must be accepted: %v", err)
	}
}

// TestIncrementalMatchesFull cross-checks the incremental append model
// against the full-comparison model on randomized three-node logs,
// including interleaved append orders and random conflicts.
func TestIncrementalMatchesFull(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	nodes := []string{"n1", "n2", "n3"}
	for trial := 0; trial < 2000; trial++ {
		// Build a base log, then give each node a (possibly diverging,
		// possibly truncated) copy.
		baseLen := rng.Intn(8)
		base := make([]string, baseLen)
		for i := range base {
			base[i] = fmt.Sprintf("v%d", rng.Intn(4))
		}
		logs := make(map[string][]string)
		for _, n := range nodes {
			l := make([]string, baseLen)
			copy(l, base)
			for i := range l {
				if rng.Intn(10) == 0 { // 10% divergence per entry
					l[i] = fmt.Sprintf("w%d", rng.Intn(3))
				}
			}
			if rng.Intn(3) == 0 && len(l) > 0 { // truncate like a crash
				l = l[:rng.Intn(len(l)+1)]
			}
			logs[n] = l
		}

		// Feed entries to the incremental checker in a random interleave.
		type appendOp struct {
			node, value string
		}
		var ops []appendOp
		for _, n := range nodes {
			for _, v := range logs[n] {
				ops = append(ops, appendOp{n, v})
			}
		}
		rng.Shuffle(len(ops), func(i, j int) { ops[i], ops[j] = ops[j], ops[i] })

		ic := NewIncrChecker()
		for _, op := range ops {
			ic.Append(op.node, op.value)
		}
		incrC, incrFound := ic.Result()
		fullC, fullFound := FullCheck(ic.LogSet())
		if incrFound != fullFound || (incrFound && incrC != fullC) {
			t.Fatalf("trial %d: mismatch incremental=(%v,%v) full=(%v,%v) logs=%v",
				trial, incrC, incrFound, fullC, fullFound, logs)
		}
	}
}

// TestIncrementalStreamingMatchesFull verifies the parser-driven
// incremental path used by `check -incr`.
func TestIncrementalStreamingMatchesFull(t *testing.T) {
	text := `
status n1 ok
status n2 crashed
status n3 unknown
entry n1 a
entry n2 a
entry n1 b
entry n3 a
entry n2 q
entry n1 c
`
	ic := NewIncrChecker()
	if err := ParseLog(strings.NewReader(text), ic); err != nil {
		t.Fatal(err)
	}
	incrC, incrFound := ic.Result()
	fullC, fullFound := FullCheck(ic.LogSet())
	if !incrFound || !fullFound {
		t.Fatal("expected conflict at index 1")
	}
	if incrC != fullC {
		t.Fatalf("incremental %v != full %v", incrC, fullC)
	}
	if incrC.Index != 1 || incrC.NodeA != "n1" || incrC.NodeB != "n2" {
		t.Fatalf("unexpected conflict %v", incrC)
	}
}
