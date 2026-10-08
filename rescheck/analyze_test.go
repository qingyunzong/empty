package rescheck

import (
	"strings"
	"testing"
)

func kinds(vs []Violation) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.Kind + ":" + v.Var
	}
	return out
}

func expect(t *testing.T, prog Stmt, want ...string) []Violation {
	t.Helper()
	got := Check(prog)
	if len(got) != len(want) {
		t.Fatalf("got %d violations %v, want %d %v", len(got), kinds(got), len(want), want)
	}
	for i, w := range want {
		if kinds(got)[i] != w {
			t.Fatalf("violation %d = %q, want %q (all: %v)", i, kinds(got)[i], w, kinds(got))
		}
	}
	return got
}

// --- straight-line basics ---

func TestCreateThenConsumeOK(t *testing.T) {
	expect(t, Seq{New{"x"}, Consume{"x"}})
}

func TestDoubleConsume(t *testing.T) {
	expect(t, Seq{New{"x"}, Consume{"x"}, Consume{"x"}}, "invalid-consume:x")
}

func TestLeakAtExit(t *testing.T) {
	expect(t, Seq{New{"x"}}, "leak-at-exit:x")
}

func TestConsumeUninitialized(t *testing.T) {
	expect(t, Seq{Consume{"x"}}, "invalid-consume:x")
}

// --- move semantics: source is invalidated ---

func TestMoveThenConsumeDst(t *testing.T) {
	expect(t, Seq{New{"x"}, Move{Dst: "y", Src: "x"}, Consume{"y"}})
}

func TestMoveInvalidatesSource(t *testing.T) {
	expect(t, Seq{New{"x"}, Move{Dst: "y", Src: "x"}, Consume{"x"}, Consume{"y"}},
		"invalid-consume:x")
}

func TestMoveFromDead(t *testing.T) {
	expect(t, Seq{New{"x"}, Move{Dst: "y", Src: "x"}, Move{Dst: "z", Src: "x"}, Consume{"y"}},
		"invalid-move:x")
}

func TestMoveOverwritesLiveDst(t *testing.T) {
	expect(t, Seq{New{"x"}, New{"y"}, Move{Dst: "y", Src: "x"}, Consume{"y"}},
		"leak-overwrite:y")
}

// --- branch merge points ---

func TestBranchOnlyOneSideCreates(t *testing.T) {
	vs := expect(t, Seq{
		If{Then: Seq{New{"x"}}, Else: Seq{}},
		Consume{"x"},
	}, "invalid-consume:x")
	if !strings.Contains(vs[0].String(), "else") {
		t.Fatalf("violation path should go through else branch: %v", vs[0])
	}
}

func TestBranchBothSidesConsume(t *testing.T) {
	expect(t, Seq{
		New{"x"},
		If{Then: Seq{Consume{"x"}}, Else: Seq{Consume{"x"}}},
	})
}

func TestBranchMergeStateUnion(t *testing.T) {
	// After the merge, x is consumed on one path and alive on the other;
	// both must be checked at exit: exactly one leak.
	vs := expect(t, Seq{
		New{"x"},
		If{Then: Seq{Consume{"x"}}, Else: Seq{}},
	}, "leak-at-exit:x")
	if !strings.Contains(vs[0].String(), "else") {
		t.Fatalf("leak path should be the else branch: %v", vs[0])
	}
}

func TestBranchMoveMerge(t *testing.T) {
	// Both branches move x into y; merged state has y alive, x moved.
	expect(t, Seq{
		New{"x"},
		If{Then: Seq{Move{Dst: "y", Src: "x"}}, Else: Seq{Move{Dst: "y", Src: "x"}}},
		Consume{"y"},
	})
}

// --- loops: fixpoint over the finite domain ---

func TestLoopCreateConsumeEachIter(t *testing.T) {
	// Fixpoint: head = {empty, consumed}; body maps both to consumed.
	expect(t, Seq{
		While{Body: Seq{New{"t"}, Consume{"t"}}},
	})
}

func TestLoopConsumesOuterResourceTwice(t *testing.T) {
	// Iteration 1 consumes x; the fixpoint feeds the consumed state back
	// to the loop head, so iteration 2 is an invalid consume. Also, the
	// loop may run zero times, leaving x alive at exit: a genuine leak.
	vs := expect(t, Seq{
		New{"x"},
		While{Body: Seq{Consume{"x"}}},
	}, "invalid-consume:x", "leak-at-exit:x")
	if !strings.Contains(vs[0].String(), "iter-2") {
		t.Fatalf("violation should appear on the second iteration: %v", vs[0])
	}
}

func TestLoopLeakInsideBody(t *testing.T) {
	// t stays alive across the back edge: overwrite leak on iter 2 and
	// a live t at loop exit.
	expect(t, Seq{
		While{Body: Seq{New{"t"}}},
	}, "leak-overwrite:t", "leak-at-exit:t")
}

func TestLoopConsumeAfterLoopOK(t *testing.T) {
	// Resource consumed and re-created each iteration; consumed after exit.
	expect(t, Seq{
		New{"x"},
		While{Body: Seq{Consume{"x"}, New{"x"}}},
		Consume{"x"},
	})
}

func TestLoopFixpointTerminates(t *testing.T) {
	// Diamond inside a loop: state count is bounded by 4^n, so the
	// fixpoint must converge quickly.
	prog := Seq{
		New{"a"},
		While{Body: Seq{
			If{Then: Seq{Move{Dst: "b", Src: "a"}}, Else: Seq{Move{Dst: "b", Src: "a"}}},
			If{Then: Seq{Move{Dst: "a", Src: "b"}}, Else: Seq{Move{Dst: "a", Src: "b"}}},
		}},
		Consume{"a"},
	}
	expect(t, prog)
}

// --- exceptional exits ---

func TestThrowWithLiveResource(t *testing.T) {
	vs := expect(t, Seq{
		New{"x"},
		If{Then: Seq{Throw{}}, Else: Seq{Consume{"x"}}},
	}, "leak-at-throw:x")
	if !strings.Contains(vs[0].String(), "throw") {
		t.Fatalf("violation path should end in throw: %v", vs[0])
	}
}

func TestThrowAfterConsumeOK(t *testing.T) {
	expect(t, Seq{New{"x"}, Consume{"x"}, Throw{}})
}

func TestThrowInsideLoop(t *testing.T) {
	// Each iteration either throws (must have consumed) or continues.
	expect(t, Seq{
		While{Body: Seq{
			New{"t"},
			If{Then: Seq{Consume{"t"}, Throw{}}, Else: Seq{Consume{"t"}}},
		}},
	})
}

// --- witness paths ---

func TestViolationPathIsReadable(t *testing.T) {
	// The then branch consumes x, so the post-merge consume is invalid
	// on the then path only.
	vs := expect(t, Seq{
		New{"x"},
		If{Then: Seq{Consume{"x"}}, Else: Seq{}},
		Consume{"x"},
	}, "invalid-consume:x")
	s := vs[0].String()
	for _, want := range []string{"new x", "then", "consume x"} {
		if !strings.Contains(s, want) {
			t.Fatalf("path %q missing step %q", s, want)
		}
	}
}
