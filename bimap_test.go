package bimap

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func mustCommit(t *testing.T, tx *Tx[string, int]) {
	t.Helper()
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit failed: %v", err)
	}
}

func TestPutGetAndReverseLookup(t *testing.T) {
	m := New[string, int]()
	if err := m.Put("a", 1); err != nil {
		t.Fatalf("put: %v", err)
	}
	if v, ok := m.Get("a"); !ok || v != 1 {
		t.Fatalf("Get(a) = %v, %v; want 1, true", v, ok)
	}
	if k, ok := m.GetKey(1); !ok || k != "a" {
		t.Fatalf("GetKey(1) = %v, %v; want a, true", k, ok)
	}
	if _, ok := m.GetKey(99); ok {
		t.Fatal("GetKey(99) should miss")
	}
}

func TestDuplicateValueRejected(t *testing.T) {
	m := New[string, int]()
	if err := m.Put("a", 1); err != nil {
		t.Fatalf("put: %v", err)
	}
	err := m.Put("b", 1)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	if m.Len() != 1 {
		t.Fatalf("Len = %d; want 1", m.Len())
	}
}

func TestFailedCommitKeepsWholeTable(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Put("a", 1)
	tx.Put("b", 2)
	mustCommit(t, tx)
	before := m.Version()

	// "c" -> 2 collides with b's occupied value; the whole tx must be dropped.
	tx = m.Begin()
	tx.Put("c", 2)
	tx.Put("d", 4)
	tx.Remove("a")
	err := tx.Commit()
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}

	if m.Version() != before {
		t.Fatalf("version moved on failure: %d -> %d", before, m.Version())
	}
	if m.Len() != 2 {
		t.Fatalf("Len = %d; want 2", m.Len())
	}
	for k, want := range map[string]int{"a": 1, "b": 2} {
		if v, ok := m.Get(k); !ok || v != want {
			t.Fatalf("Get(%q) = %v, %v; want %d, true", k, v, ok, want)
		}
	}
	if _, ok := m.Get("c"); ok {
		t.Fatal("staged key c leaked into the table")
	}
	if _, ok := m.GetKey(4); ok {
		t.Fatal("staged value 4 leaked into the reverse index")
	}
}

func TestSwapOccupiedValues(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Put("a", 1)
	tx.Put("b", 2)
	mustCommit(t, tx)

	if err := m.Swap("a", "b"); err != nil {
		t.Fatalf("swap: %v", err)
	}
	if v, _ := m.Get("a"); v != 2 {
		t.Fatalf("a = %d; want 2", v)
	}
	if v, _ := m.Get("b"); v != 1 {
		t.Fatalf("b = %d; want 1", v)
	}
	if k, _ := m.GetKey(1); k != "b" {
		t.Fatalf("GetKey(1) = %q; want b", k)
	}
	if k, _ := m.GetKey(2); k != "a" {
		t.Fatalf("GetKey(2) = %q; want a", k)
	}
}

func TestThreeCycleSwap(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Put("a", 1)
	tx.Put("b", 2)
	tx.Put("c", 3)
	mustCommit(t, tx)

	// Rotate occupied values: a<-2, b<-3, c<-1. Every target value is
	// still occupied, so this only works because old relations of the
	// transaction's own keys are removed before the conflict check.
	tx = m.Begin()
	tx.Put("a", 2)
	tx.Put("b", 3)
	tx.Put("c", 1)
	mustCommit(t, tx)

	wantFwd := map[string]int{"a": 2, "b": 3, "c": 1}
	for k, want := range wantFwd {
		if v, ok := m.Get(k); !ok || v != want {
			t.Fatalf("Get(%q) = %v, %v; want %d, true", k, v, ok, want)
		}
	}
	for v, want := range map[int]string{1: "c", 2: "a", 3: "b"} {
		if k, ok := m.GetKey(v); !ok || k != want {
			t.Fatalf("GetKey(%d) = %q, %v; want %q, true", v, k, ok, want)
		}
	}
}

func TestVersionSnapshots(t *testing.T) {
	m := New[string, int]()
	if err := m.Put("a", 1); err != nil {
		t.Fatalf("put: %v", err)
	}
	v1 := m.Version()
	if err := m.Put("b", 2); err != nil {
		t.Fatalf("put: %v", err)
	}
	if err := m.Remove("a"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	v3 := m.Version()

	s1, ok := m.Snapshot(v1)
	if !ok {
		t.Fatalf("snapshot %d missing", v1)
	}
	if s1.Version() != v1 || s1.Len() != 1 {
		t.Fatalf("snapshot meta = (%d, %d); want (%d, 1)", s1.Version(), s1.Len(), v1)
	}
	if v, ok := s1.Get("a"); !ok || v != 1 {
		t.Fatalf("snapshot Get(a) = %v, %v; want 1, true", v, ok)
	}
	if k, ok := s1.GetKey(1); !ok || k != "a" {
		t.Fatalf("snapshot GetKey(1) = %q, %v; want a, true", k, ok)
	}

	s3, ok := m.Snapshot(v3)
	if !ok {
		t.Fatalf("snapshot %d missing", v3)
	}
	if _, ok := s3.Get("a"); ok {
		t.Fatal("latest snapshot should not contain a")
	}
	if k, ok := s3.GetKey(2); !ok || k != "b" {
		t.Fatalf("snapshot GetKey(2) = %q, %v; want b, true", k, ok)
	}

	// Snapshots are immutable: later commits must not mutate s1.
	if err := m.Put("z", 26); err != nil {
		t.Fatalf("put: %v", err)
	}
	if s1.Len() != 1 {
		t.Fatalf("snapshot mutated by later commit: Len = %d", s1.Len())
	}
}

// model is an independent dual-map reference implementation used to
// cross-check BiMap on random transaction batches.
type model struct {
	fwd map[string]int
	rev map[int]string
}

func newModel() *model {
	return &model{fwd: map[string]int{}, rev: map[int]string{}}
}

func (md *model) commit(puts map[string]int, removes map[string]bool) error {
	fwd := make(map[string]int, len(md.fwd))
	for k, v := range md.fwd {
		fwd[k] = v
	}
	for k := range removes {
		delete(fwd, k)
	}
	for k := range puts {
		delete(fwd, k)
	}
	rev := make(map[int]string, len(fwd))
	for k, v := range fwd {
		rev[v] = k
	}
	for k, v := range puts {
		if _, taken := rev[v]; taken {
			return ErrConflict
		}
		rev[v] = k
		fwd[k] = v
	}
	md.fwd, md.rev = fwd, rev
	return nil
}

func TestRandomBatchesAgainstDualMapModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	m := New[string, int]()
	md := newModel()

	keys := []string{"a", "b", "c", "d", "e", "f"}
	const maxValue = 8

	snapshots := map[uint64]map[string]int{0: {}}

	for round := 0; round < 2000; round++ {
		puts := map[string]int{}
		removes := map[string]bool{}
		tx := m.Begin()
		for i, n := 0, 1+rng.Intn(4); i < n; i++ {
			k := keys[rng.Intn(len(keys))]
			if rng.Intn(3) == 0 {
				tx.Remove(k)
				delete(puts, k)
				removes[k] = true
			} else {
				v := rng.Intn(maxValue)
				tx.Put(k, v)
				puts[k] = v
				delete(removes, k)
			}
		}

		gotErr := tx.Commit()
		wantErr := md.commit(puts, removes)
		if (gotErr == nil) != (wantErr == nil) {
			t.Fatalf("round %d: commit err = %v, model err = %v", round, gotErr, wantErr)
		}

		if m.Len() != len(md.fwd) {
			t.Fatalf("round %d: Len = %d, model = %d", round, m.Len(), len(md.fwd))
		}
		for k, want := range md.fwd {
			if v, ok := m.Get(k); !ok || v != want {
				t.Fatalf("round %d: Get(%q) = %v, %v; want %d, true", round, k, v, ok, want)
			}
		}
		for v, want := range md.rev {
			if k, ok := m.GetKey(v); !ok || k != want {
				t.Fatalf("round %d: GetKey(%d) = %q, %v; want %q, true", round, v, k, ok, want)
			}
		}

		if gotErr == nil {
			state := make(map[string]int, len(md.fwd))
			for k, v := range md.fwd {
				state[k] = v
			}
			snapshots[m.Version()] = state
		}
	}

	// Every recorded snapshot must replay the model state at that version,
	// including reverse lookups.
	for version, want := range snapshots {
		s, ok := m.Snapshot(version)
		if !ok {
			t.Fatalf("snapshot %d missing", version)
		}
		got := map[string]int{}
		s.Range(func(k string, v int) bool {
			got[k] = v
			if rk, ok := s.GetKey(v); !ok || rk != k {
				t.Fatalf("snapshot %d: GetKey(%d) = %q, %v; want %q, true", version, v, rk, ok, k)
			}
			return true
		})
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("snapshot %d = %v; want %v", version, got, want)
		}
	}
}
