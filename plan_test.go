package plan

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func kv(s string) Value { return Value{Data: s, OK: true} }

func initialState(n int) map[string]Value {
	m := make(map[string]Value, n)
	for i := 0; i < n; i++ {
		m[fmt.Sprintf("k%d", i)] = kv(fmt.Sprintf("v%d", i))
	}
	return m
}

func buildPlan(n int) []Step {
	steps := make([]Step, n)
	for i := 0; i < n; i++ {
		key := fmt.Sprintf("k%d", i)
		steps[i] = SetStep(key, kv(fmt.Sprintf("v%d", i)), kv(fmt.Sprintf("w%d", i)))
	}
	return steps
}

func postImage(name string) Value {
	var i int
	fmt.Sscanf(name, "set k%d", &i)
	return kv(fmt.Sprintf("w%d", i))
}

// verifyOutcome checks the universal invariant: after Execute, the store
// must equal the initial state plus exactly the post-images of the steps
// recorded in the Pending tail — full recovery, or evidence of what is
// not yet recovered, and nothing else.
func verifyOutcome(t *testing.T, fs *FakeStore, steps []Step, res Result) {
	t.Helper()

	want := initialState(len(steps))
	if res.Err == nil {
		for i := range steps {
			want[fmt.Sprintf("k%d", i)] = kv(fmt.Sprintf("w%d", i))
		}
		if len(res.Pending) != 0 || len(res.Undone) != 0 {
			t.Errorf("successful run has rollback artefacts: pending=%v undone=%v", res.Pending, res.Undone)
		}
		if !reflect.DeepEqual(res.Applied, names(steps)) {
			t.Errorf("applied = %v, want all steps", res.Applied)
		}
	} else {
		pendingIdx := map[int]bool{}
		for _, p := range res.Pending {
			found := false
			for i, st := range steps {
				if st.Name == p.Name {
					pendingIdx[i] = true
					found = true
				}
			}
			if !found {
				t.Errorf("pending step %q not in plan", p.Name)
			}
			want[p.Name[4:]] = postImage(p.Name)
		}
		// Applied must be a prefix of the plan.
		for i, name := range res.Applied {
			if name != steps[i].Name {
				t.Errorf("applied[%d] = %q, want %q", i, name, steps[i].Name)
			}
		}
		// Every applied step is either undone or pending.
		if len(res.Undone)+len(res.Pending) != len(res.Applied) {
			t.Errorf("undone(%d) + pending(%d) != applied(%d)", len(res.Undone), len(res.Pending), len(res.Applied))
		}
		undoneSet := map[string]bool{}
		for _, name := range res.Undone {
			undoneSet[name] = true
		}
		for i := range res.Applied {
			if !undoneSet[res.Applied[i]] && !pendingIdx[i] {
				t.Errorf("applied step %d neither undone nor pending", i)
			}
		}
		if len(res.Pending) == 0 && !res.FullyRecovered() {
			t.Errorf("no pending tail but FullyRecovered is false")
		}
		if len(res.Pending) > 0 && res.UndoErr == nil {
			t.Errorf("pending tail without UndoErr evidence")
		}
	}

	if got := fs.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Errorf("store = %v, want %v (err=%v undoErr=%v)", got, want, res.Err, res.UndoErr)
	}
}

func names(steps []Step) []string {
	out := make([]string, len(steps))
	for i, st := range steps {
		out[i] = st.Name
	}
	return out
}

func TestSuccessAppliesAllSteps(t *testing.T) {
	const n = 3
	fs := NewFakeStore(initialState(n))
	res := Execute(fs, buildPlan(n))
	verifyOutcome(t, fs, buildPlan(n), res)
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
}

func TestSuccessWithCreateAndDelete(t *testing.T) {
	s := NewMemStore(map[string]Value{"old": kv("x")})
	res := Execute(s, []Step{
		CreateStep("new", "y"),
		DeleteStep("old", kv("x")),
	})
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	want := map[string]Value{"new": kv("y")}
	if got := s.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Errorf("store = %v, want %v", got, want)
	}
}

func TestPreconditionFailureRollsBack(t *testing.T) {
	s := NewMemStore(map[string]Value{"a": kv("a0"), "b": kv("b0")})
	steps := []Step{
		SetStep("a", kv("a0"), kv("a1")),
		SetStep("b", kv("WRONG"), kv("b1")), // precondition cannot hold
	}
	res := Execute(s, steps)
	if res.Err == nil {
		t.Fatal("expected precondition failure")
	}
	if !res.FullyRecovered() {
		t.Fatalf("pending tail = %v, want full recovery", res.Pending)
	}
	if got := s.Snapshot(); !reflect.DeepEqual(got, map[string]Value{"a": kv("a0"), "b": kv("b0")}) {
		t.Errorf("store = %v, want initial state", got)
	}
	if !reflect.DeepEqual(res.Undone, []string{"set a"}) {
		t.Errorf("undone = %v, want [set a]", res.Undone)
	}
}

func TestExternalModificationBeforeApplyIsNotOverwritten(t *testing.T) {
	s := NewMemStore(map[string]Value{"k": kv("orig")})
	steps := []Step{SetStep("k", kv("orig"), kv("new"))}
	// External actor rewrites the key before the plan runs.
	if err := s.CAS("k", kv("orig"), kv("extern")); err != nil {
		t.Fatal(err)
	}
	res := Execute(s, steps)
	if res.Err == nil {
		t.Fatal("expected failure from stale precondition")
	}
	if got := s.Get("k"); got != kv("extern") {
		t.Errorf("external value overwritten: got %+v", got)
	}
}

func TestCASConflictWithoutPreIsNotOverwritten(t *testing.T) {
	s := NewMemStore(map[string]Value{"k": kv("orig")})
	st := SetStep("k", kv("orig"), kv("new"))
	st.Pre = nil // even with the precondition skipped, CAS must protect
	if err := s.CAS("k", kv("orig"), kv("extern")); err != nil {
		t.Fatal(err)
	}
	res := Execute(s, []Step{st})
	if !errors.Is(res.Err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", res.Err)
	}
	if got := s.Get("k"); got != kv("extern") {
		t.Errorf("external value overwritten: got %+v", got)
	}
}

func TestUndoConflictLeavesPendingTail(t *testing.T) {
	fs := NewFakeStore(map[string]Value{"a": kv("a0"), "b": kv("b0")})
	steps := []Step{
		SetStep("a", kv("a0"), kv("a1")),
		SetStep("b", kv("b0"), kv("b1")),
		{
			Name: "interfere-then-fail",
			Apply: func(s Store) error {
				// An external actor rewrites "a" while the plan is in
				// flight, then this step fails and triggers rollback.
				if err := s.CAS("a", kv("a1"), kv("a-extern")); err != nil {
					return err
				}
				return errors.New("boom")
			},
		},
	}
	res := Execute(fs, steps)
	if res.Err == nil {
		t.Fatal("expected failure")
	}
	if !errors.Is(res.UndoErr, ErrConflict) {
		t.Errorf("undoErr = %v, want ErrConflict", res.UndoErr)
	}
	if len(res.Pending) != 1 || res.Pending[0].Name != "set a" {
		t.Fatalf("pending = %v, want [set a]", res.Pending)
	}
	// The externally modified value must survive: not forcibly reverted.
	if got := fs.Get("a"); got != kv("a-extern") {
		t.Errorf("a = %+v, want externally modified value preserved", got)
	}
	// The untouched step must be rolled back.
	if got := fs.Get("b"); got != kv("b0") {
		t.Errorf("b = %+v, want rolled back to b0", got)
	}
}

// TestExhaustiveSingleFault injects one fault at every possible mutation
// point of a failing run and verifies full recovery or exact evidence.
func TestExhaustiveSingleFault(t *testing.T) {
	const n = 4
	// A run performs at most n applies plus n-1 undos = 2n-1 mutations;
	// fault positions beyond that simply never trigger (success case).
	for fault := 0; fault <= 2*n; fault++ {
		t.Run(fmt.Sprintf("fault@%d", fault), func(t *testing.T) {
			fs := NewFakeStore(initialState(n))
			fs.FailAt(fault)
			steps := buildPlan(n)
			res := Execute(fs, steps)
			verifyOutcome(t, fs, steps, res)
		})
	}
}

// TestExhaustiveDoubleFault injects every ordered pair of faults,
// covering rollback paths where two inverse actions fail.
func TestExhaustiveDoubleFault(t *testing.T) {
	const n = 3
	for f1 := 0; f1 < 2*n; f1++ {
		for f2 := f1 + 1; f2 < 2*n; f2++ {
			t.Run(fmt.Sprintf("faults@%d,%d", f1, f2), func(t *testing.T) {
				fs := NewFakeStore(initialState(n))
				fs.FailAt(f1)
				fs.FailAt(f2)
				steps := buildPlan(n)
				res := Execute(fs, steps)
				verifyOutcome(t, fs, steps, res)
			})
		}
	}
}

func TestMemStoreCASConflict(t *testing.T) {
	s := NewMemStore(map[string]Value{"k": kv("v")})
	if err := s.CAS("k", kv("other"), kv("new")); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	if got := s.Get("k"); got != kv("v") {
		t.Errorf("k = %+v after conflict, want unchanged", got)
	}
	if err := s.CAS("k", kv("v"), Value{}); err != nil {
		t.Fatal(err)
	}
	if got := s.Get("k"); got.OK {
		t.Errorf("k = %+v, want deleted", got)
	}
}
