package planexec

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
)

// kvStep builds a step that sets key=value, with precondition "key absent",
// post-image "key == value" and inverse "delete key".
func kvStep(name, key, value string) Step {
	return Step{
		Name: name,
		Pre: func(s Store) error {
			if _, ok := s.Get(key); ok {
				return fmt.Errorf("key %q already present", key)
			}
			return nil
		},
		Do: func(s Store) error { return s.Set(key, value) },
		Image: func(s Store) error {
			v, ok := s.Get(key)
			if !ok || v != value {
				return fmt.Errorf("post-image mismatch for %q: got %q, want %q", key, v, value)
			}
			return nil
		},
		Undo: func(s Store) error { return s.Delete(key) },
	}
}

func boomStep(name string) Step {
	return Step{
		Name: name,
		Do:   func(Store) error { return errors.New("boom") },
	}
}

func newSeededStore() *MemStore {
	m := NewMemStore()
	_ = m.Set("seed", "original")
	return m
}

func TestExecuteSuccess(t *testing.T) {
	s := newSeededStore()
	r := Execute(s, []Step{kvStep("a", "k1", "v1"), kvStep("b", "k2", "v2")})
	if !r.OK() {
		t.Fatalf("expected success, got %+v", r)
	}
	if !reflect.DeepEqual(r.Applied, []string{"a", "b"}) {
		t.Fatalf("applied = %v", r.Applied)
	}
	if v, _ := s.Get("k2"); v != "v2" {
		t.Fatalf("k2 = %q", v)
	}
	if len(r.Pending) != 0 || len(r.RolledBack) != 0 {
		t.Fatalf("unexpected rollback state: %+v", r)
	}
}

func TestPreconditionFailureRollsBackInReverse(t *testing.T) {
	s := newSeededStore()
	steps := []Step{
		kvStep("a", "k1", "v1"),
		kvStep("b", "k2", "v2"),
		kvStep("c", "k1", "dup"), // precondition fails: k1 already present
	}
	r := Execute(s, steps)
	if r.OK() || r.FailedStep != 2 {
		t.Fatalf("expected failure at step 2, got %+v", r)
	}
	if !reflect.DeepEqual(r.RolledBack, []string{"b", "a"}) {
		t.Fatalf("rollback order = %v, want [b a]", r.RolledBack)
	}
	if !r.Recovered() {
		t.Fatalf("pending = %v", r.Pending)
	}
	if !reflect.DeepEqual(s.Snapshot(), map[string]string{"seed": "original"}) {
		t.Fatalf("store not restored: %v", s.Snapshot())
	}
}

func TestExternalModificationNotOverwritten(t *testing.T) {
	s := newSeededStore()
	steps := []Step{
		kvStep("a", "k1", "v1"),
		{
			Name: "outsider",
			Do: func(s Store) error {
				// Simulates an unknown external actor modifying k1,
				// then a failure that triggers rollback.
				_ = s.Set("k1", "external")
				return errors.New("boom")
			},
		},
	}
	r := Execute(s, steps)
	if r.OK() {
		t.Fatal("expected failure")
	}
	if len(r.Conflicts) != 1 || r.Conflicts[0].Step != "a" {
		t.Fatalf("conflicts = %+v", r.Conflicts)
	}
	if !reflect.DeepEqual(r.Pending, []string{"a"}) {
		t.Fatalf("pending = %v", r.Pending)
	}
	if v, _ := s.Get("k1"); v != "external" {
		t.Fatalf("external modification was overwritten: k1 = %q", v)
	}
}

func TestPendingTailSaveLoad(t *testing.T) {
	s := newSeededStore()
	steps := []Step{
		kvStep("a", "k1", "v1"),
		{
			Name: "badundo",
			Do:   func(s Store) error { return s.Set("k2", "v2") },
			Undo: func(Store) error { return errors.New("undo failed") },
		},
		boomStep("boom"),
	}
	r := Execute(s, steps)
	if r.RollbackErr == nil {
		t.Fatal("expected rollback error")
	}
	if !reflect.DeepEqual(r.Pending, []string{"a", "badundo"}) {
		t.Fatalf("pending = %v", r.Pending)
	}
	path := filepath.Join(t.TempDir(), "pending.json")
	tail, err := SavePendingTailFile(path, r)
	if err != nil {
		t.Fatal(err)
	}
	if tail.Cause != "rollback_error" {
		t.Fatalf("cause = %q", tail.Cause)
	}
	loaded, err := LoadPendingTailFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded.Pending, []string{"a", "badundo"}) {
		t.Fatalf("loaded pending = %v", loaded.Pending)
	}
	// Nothing pending -> nothing saved.
	if tail, err := SavePendingTailFile(path, &Result{FailedStep: -1}); err != nil || tail != nil {
		t.Fatalf("expected (nil, nil), got (%v, %v)", tail, err)
	}
}

// TestExhaustiveFaultInjection injects a fault at every possible store-call
// index of a failing batch and checks the invariant: either the store is
// fully restored to its initial state, or the result carries evidence of
// the incomplete recovery (non-empty Pending tail that can be persisted).
func TestExhaustiveFaultInjection(t *testing.T) {
	plan := []Step{
		kvStep("s1", "k1", "v1"),
		kvStep("s2", "k2", "v2"),
		kvStep("s3", "k3", "v3"),
		boomStep("boom"),
	}
	initial := map[string]string{"seed": "original"}

	// Calibration run: count total store calls of a fault-free failing batch.
	cal := NewFakeStore(newSeededStore())
	if r := Execute(cal, plan); r.OK() || !r.Recovered() {
		t.Fatalf("calibration run: %+v", r)
	}
	total := cal.Calls()

	for failAt := 0; failAt < total; failAt++ {
		t.Run(fmt.Sprintf("failAt=%d", failAt), func(t *testing.T) {
			fs := NewFakeStore(newSeededStore())
			fs.FailAt = failAt
			r := Execute(fs, plan)
			if r.OK() {
				t.Fatal("batch unexpectedly succeeded")
			}
			inner := fs.inner.(*MemStore)
			if r.Recovered() {
				if got := inner.Snapshot(); !reflect.DeepEqual(got, initial) {
					t.Fatalf("claimed recovered but store = %v, want %v", got, initial)
				}
				return
			}
			// Not recovered: must carry persistable evidence.
			if len(r.Pending) == 0 {
				t.Fatal("incomplete recovery without pending tail")
			}
			if r.RollbackErr == nil && len(r.Conflicts) == 0 {
				t.Fatal("incomplete recovery without cause")
			}
			path := filepath.Join(t.TempDir(), "pending.json")
			tail, err := SavePendingTailFile(path, r)
			if err != nil {
				t.Fatalf("save pending tail: %v", err)
			}
			if tail == nil || len(tail.Pending) == 0 {
				t.Fatal("pending tail not persisted")
			}
		})
	}
}
