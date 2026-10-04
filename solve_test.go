package main

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func mustParse(t *testing.T, input string) []Op {
	t.Helper()
	ops, err := ParseHistory(strings.NewReader(input))
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	return ops
}

// ValidateWitness is a third, independent check that a witness produced
// by Solve is a legitimate serial explanation of the history.
func ValidateWitness(t *testing.T, ops []Op, w []Step) {
	t.Helper()
	if len(w) != len(ops) {
		t.Fatalf("witness has %d steps, want %d", len(w), len(ops))
	}
	pos := make([]int, len(ops))
	for i := range pos {
		pos[i] = -1
	}
	for p, st := range w {
		if st.Op < 0 || st.Op >= len(ops) {
			t.Fatalf("step %d: bad op index %d", p, st.Op)
		}
		if pos[st.Op] != -1 {
			t.Fatalf("op #%d appears twice", st.Op+1)
		}
		pos[st.Op] = p
	}
	// Real-time order: i must precede j => pos[i] < pos[j].
	for i := range ops {
		for j := range ops {
			if i != j && Precedes(ops, i, j) && pos[i] > pos[j] {
				t.Fatalf("real-time order violated: #%d must precede #%d", i+1, j+1)
			}
		}
	}
	// FIFO simulation.
	var queue []string
	for p, st := range w {
		op := ops[st.Op]
		if st.Omitted {
			if !op.Pending {
				t.Fatalf("step %d: op #%d is not pending but was omitted", p, op.ID)
			}
			continue
		}
		if op.Kind == Enq {
			queue = append(queue, op.Val)
			continue
		}
		// Deq: determine the effective result required by the op.
		wantEmpty, wantVal := st.DeqEmpty, st.DeqVal
		if !op.Pending {
			wantEmpty, wantVal = op.RetEmpty, op.Val
		}
		if wantEmpty {
			if len(queue) != 0 {
				t.Fatalf("step %d: deq -> empty but queue is %v", p, queue)
			}
		} else {
			if len(queue) == 0 || queue[0] != wantVal {
				t.Fatalf("step %d: deq -> %s but queue is %v", p, wantVal, queue)
			}
			queue = queue[1:]
		}
	}
}

func check(t *testing.T, input string, wantLinearizable bool) {
	t.Helper()
	ops := mustParse(t, input)
	w, ok := Solve(ops)
	if ok != wantLinearizable {
		t.Fatalf("Solve = %v, want %v\nhistory:\n%s", ok, wantLinearizable, input)
	}
	brute := BruteForce(ops)
	if brute.Linearizable != wantLinearizable {
		t.Fatalf("BruteForce = %v, want %v\nhistory:\n%s", brute.Linearizable, wantLinearizable, input)
	}
	if ok {
		ValidateWitness(t, ops, w)
	}
}

func TestLinearizableOverlapReorder(t *testing.T) {
	// enq B is called after enq A but deq A returns first; FIFO requires
	// serializing enq A before enq B even though they overlap.
	check(t, `
enq A 0 10
enq B 1 11
deq A 2 3
deq B 4 5
`, true)
}

func TestLinearizableOverlapSwap(t *testing.T) {
	// Overlapping enqs may be reordered so that B comes out first.
	check(t, `
enq A 0 10
enq B 1 11
deq B 2 3
deq A 4 5
`, true)
}

func TestRealTimeOrderForcesFIFO(t *testing.T) {
	// enq A < enq B < deq in real time, so the deq must return A.
	check(t, `
enq A 0 1
enq B 2 3
deq B 4 5
`, false)
	check(t, `
enq A 0 1
enq B 2 3
deq A 4 5
`, true)
}

func TestDeqBeforeEnq(t *testing.T) {
	// deq returns A strictly before enq A is called: impossible.
	check(t, `
deq A 0 1
enq A 2 3
`, false)
	// ... but fine when they overlap.
	check(t, `
deq A 0 5
enq A 2 3
`, true)
}

func TestEmptyDeq(t *testing.T) {
	// deq returns empty while a completed enq fully precedes it: impossible.
	check(t, `
enq A 0 1
deq - 2 3
`, false)
	// Overlapping enq can be serialized after the deq: fine.
	check(t, `
enq A 0 5
deq - 2 3
`, true)
}

func TestPendingOmit(t *testing.T) {
	// Pending enq A would poison the empty return; omit it.
	ops := mustParse(t, `
enq A 0 -
deq - 1 2
`)
	w, ok := Solve(ops)
	if !ok {
		t.Fatal("expected linearizable")
	}
	ValidateWitness(t, ops, w)
	// The deq has ret=2 which does NOT precede enq's call=0... enq is
	// pending so no constraint; either omit or serialize enq after deq.
}

func TestPendingComplete(t *testing.T) {
	// Pending deq must be completed with the front value A.
	check(t, `
enq A 0 1
deq - 2 -
`, true)
	// Pending deq on an empty queue completes as empty.
	check(t, `
deq - 0 -
`, true)
}

func TestPendingEitherWay(t *testing.T) {
	// A pending enq that cannot fit: queue must stay empty for the deq,
	// and the deq's response precedes... no constraint (enq pending), so
	// omitting the enq is the only... actually serializing enq after the
	// deq also works. Both solvers must agree it is feasible.
	check(t, `
deq - 0 1
enq A 0 -
`, true)
}

func TestTwelveOps(t *testing.T) {
	// 12 sequential enq/deq pairs, all consistent.
	var sb strings.Builder
	for i := 0; i < 6; i++ {
		fmt.Fprintf(&sb, "enq V%d %d %d\n", i, 2*i, 2*i)
	}
	for i := 0; i < 6; i++ {
		fmt.Fprintf(&sb, "deq V%d %d %d\n", i, 20+2*i, 20+2*i)
	}
	check(t, sb.String(), true)
}

func TestParseErrors(t *testing.T) {
	bad := []string{
		"enq A 0",                         // too few fields
		"foo A 0 1",                       // unknown op
		"enq - 0 1",                       // enq without value
		"enq A 5 1",                       // ret before call
		"enq A x 1",                       // bad call time
		"",                                // empty history
		strings.Repeat("enq A 0 1\n", 13), // too many ops
	}
	for _, in := range bad {
		if _, err := ParseHistory(strings.NewReader(in)); err == nil {
			t.Errorf("expected parse error for %q", in)
		}
	}
}

// TestRandomizedCrossCheck compares Solve against the independent
// BruteForce enumeration on random histories, and validates witnesses.
func TestRandomizedCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	vals := []string{"A", "B"}
	for trial := 0; trial < 3000; trial++ {
		n := 1 + rng.Intn(9) // 1..9 ops keeps brute force fast
		var sb strings.Builder
		for i := 0; i < n; i++ {
			call := rng.Intn(2 * n)
			ret := call + rng.Intn(4)
			retStr := fmt.Sprint(ret)
			if rng.Intn(4) == 0 {
				retStr = "-"
			}
			if rng.Intn(2) == 0 {
				fmt.Fprintf(&sb, "enq %s %d %s\n", vals[rng.Intn(len(vals))], call, retStr)
			} else {
				v := "-"
				if rng.Intn(3) > 0 {
					v = vals[rng.Intn(len(vals))]
				}
				fmt.Fprintf(&sb, "deq %s %d %s\n", v, call, retStr)
			}
		}
		input := sb.String()
		ops, err := ParseHistory(strings.NewReader(input))
		if err != nil {
			t.Fatalf("trial %d: parse error: %v\n%s", trial, err, input)
		}
		w, ok := Solve(ops)
		brute := BruteForce(ops)
		if ok != brute.Linearizable {
			t.Fatalf("trial %d: solvers disagree: Solve=%v Brute=%v\n%s",
				trial, ok, brute.Linearizable, input)
		}
		if ok {
			ValidateWitness(t, ops, w)
		}
	}
}

func TestCLI(t *testing.T) {
	code := run([]string{"queuecheck"}, strings.NewReader("enq A 0 1\ndeq A 2 3\n"),
		&strings.Builder{}, &strings.Builder{})
	if code != 0 {
		t.Errorf("linearizable history: exit code = %d, want 0", code)
	}
	var out strings.Builder
	code = run([]string{"queuecheck"}, strings.NewReader("deq A 0 1\nenq A 2 3\n"),
		&out, &strings.Builder{})
	if code != 1 {
		t.Errorf("non-linearizable history: exit code = %d, want 1", code)
	}
	if !strings.Contains(out.String(), "NOT LINEARIZABLE") {
		t.Errorf("expected NOT LINEARIZABLE in output, got:\n%s", out.String())
	}
	code = run([]string{"queuecheck"}, strings.NewReader("garbage\n"),
		&strings.Builder{}, &strings.Builder{})
	if code != 2 {
		t.Errorf("bad input: exit code = %d, want 2", code)
	}
}
