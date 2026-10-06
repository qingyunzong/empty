package bimap

import (
	"fmt"
	"math/rand"
	"testing"
)

func TestSetGetAndReverseLookup(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 2)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if v, ok := m.Get("a"); !ok || v != 1 {
		t.Fatalf("Get(a) = %v, %v", v, ok)
	}
	if k, ok := m.GetByValue(2); !ok || k != "b" {
		t.Fatalf("GetByValue(2) = %v, %v", k, ok)
	}
	if _, ok := m.GetByValue(99); ok {
		t.Fatal("GetByValue(99) should miss")
	}
	if m.Len() != 2 {
		t.Fatalf("Len = %d", m.Len())
	}
}

func TestValueUniquenessConflict(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 2)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// "c" wants value 2, still occupied by "b" (not part of the tx).
	tx2 := m.Begin()
	tx2.Set("c", 2)
	err := m.Commit(tx2)
	if err == nil {
		t.Fatal("expected conflict")
	}
	if _, isConflict := err.(*ConflictError); !isConflict {
		t.Fatalf("expected *ConflictError, got %T", err)
	}
	// Table must be fully intact.
	if m.Len() != 2 {
		t.Fatalf("Len after failed commit = %d", m.Len())
	}
	if k, ok := m.GetByValue(2); !ok || k != "b" {
		t.Fatalf("value 2 should still belong to b, got %v", k)
	}
	if _, ok := m.Get("c"); ok {
		t.Fatal("c must not exist after failed commit")
	}
}

func TestDuplicateValueWithinOneTx(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 1) // two keys, same value in one batch
	if err := m.Commit(tx); err == nil {
		t.Fatal("expected conflict for duplicate value in one tx")
	}
	if m.Len() != 0 {
		t.Fatalf("table must stay empty, Len = %d", m.Len())
	}
}

func TestSwapTwoOccupiedValues(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 2)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Swap the two occupied values in a single transaction.
	tx2 := m.Begin()
	tx2.Set("a", 2)
	tx2.Set("b", 1)
	if err := m.Commit(tx2); err != nil {
		t.Fatalf("swap should succeed, got %v", err)
	}
	if v, _ := m.Get("a"); v != 2 {
		t.Fatalf("a = %d, want 2", v)
	}
	if v, _ := m.Get("b"); v != 1 {
		t.Fatalf("b = %d, want 1", v)
	}
	if k, _ := m.GetByValue(1); k != "b" {
		t.Fatalf("value 1 held by %v, want b", k)
	}
	if k, _ := m.GetByValue(2); k != "a" {
		t.Fatalf("value 2 held by %v, want a", k)
	}
}

func TestThreeCycleSwap(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 2)
	tx.Set("c", 3)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Rotate: a<-2, b<-3, c<-1. Every target value is occupied, but all
	// occupants are rewritten inside the same transaction.
	tx2 := m.Begin()
	tx2.Set("a", 2)
	tx2.Set("b", 3)
	tx2.Set("c", 1)
	if err := m.Commit(tx2); err != nil {
		t.Fatalf("three-cycle swap should succeed, got %v", err)
	}
	want := map[string]int{"a": 2, "b": 3, "c": 1}
	for k, wv := range want {
		if v, ok := m.Get(k); !ok || v != wv {
			t.Fatalf("Get(%s) = %v, %v; want %d", k, v, ok, wv)
		}
		if rk, ok := m.GetByValue(wv); !ok || rk != k {
			t.Fatalf("GetByValue(%d) = %v, %v; want %s", wv, rk, ok, k)
		}
	}
}

func TestDeleteFreesValue(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	tx2 := m.Begin()
	tx2.Delete("a")
	tx2.Set("b", 1) // value freed by the delete in the same tx
	if err := m.Commit(tx2); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, ok := m.Get("a"); ok {
		t.Fatal("a should be deleted")
	}
	if k, ok := m.GetByValue(1); !ok || k != "b" {
		t.Fatalf("value 1 should belong to b, got %v", k)
	}
}

func TestFailedCommitKeepsWholeTableAndVersion(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 2)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	verBefore := m.Version()

	tx2 := m.Begin()
	tx2.Set("c", 3) // fine
	tx2.Set("d", 2) // conflicts with b
	tx2.Delete("a") // must be rolled back too
	if err := m.Commit(tx2); err == nil {
		t.Fatal("expected conflict")
	}
	if m.Version() != verBefore {
		t.Fatalf("version moved on failure: %d -> %d", verBefore, m.Version())
	}
	if v, ok := m.Get("a"); !ok || v != 1 {
		t.Fatal("a must survive the failed commit")
	}
	if _, ok := m.Get("c"); ok {
		t.Fatal("c must not appear after failed commit")
	}
	if m.Len() != 2 {
		t.Fatalf("Len = %d, want 2", m.Len())
	}
}

func TestVersionSnapshots(t *testing.T) {
	m := New[string, int]()
	tx := m.Begin()
	tx.Set("a", 1)
	tx.Set("b", 2)
	if err := m.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	tx2 := m.Begin()
	tx2.Set("a", 2)
	tx2.Set("b", 1)
	if err := m.Commit(tx2); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if m.Version() != 2 {
		t.Fatalf("Version = %d, want 2", m.Version())
	}
	s0, ok := m.Snapshot(0)
	if !ok || s0.Len() != 0 {
		t.Fatalf("snapshot 0: ok=%v len=%d", ok, s0.Len())
	}
	s1, ok := m.Snapshot(1)
	if !ok {
		t.Fatal("snapshot 1 missing")
	}
	if v, _ := s1.Get("a"); v != 1 {
		t.Fatalf("snapshot 1: a = %d, want 1", v)
	}
	if k, _ := s1.GetByValue(2); k != "b" {
		t.Fatalf("snapshot 1: value 2 held by %v, want b", k)
	}
	s2, _ := m.Snapshot(2)
	if v, _ := s2.Get("a"); v != 2 {
		t.Fatalf("snapshot 2: a = %d, want 2", v)
	}
	if _, ok := m.Snapshot(3); ok {
		t.Fatal("snapshot 3 should not exist")
	}

	// Snapshots are immutable: later commits must not mutate them.
	tx3 := m.Begin()
	tx3.Set("a", 9)
	if err := m.Commit(tx3); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if v, _ := s2.Get("a"); v != 2 {
		t.Fatalf("snapshot 2 mutated: a = %d, want 2", v)
	}
}

// model is the reference implementation: two plain maps kept in sync,
// mirroring the documented commit semantics.
type model struct {
	k2v map[string]int
	v2k map[int]string
}

func newModel() *model {
	return &model{k2v: make(map[string]int), v2k: make(map[int]string)}
}

func (md *model) commit(sets map[string]int, dels map[string]bool) bool {
	k2v := make(map[string]int, len(md.k2v))
	for k, v := range md.k2v {
		k2v[k] = v
	}
	v2k := make(map[int]string, len(md.v2k))
	for v, k := range md.v2k {
		v2k[v] = k
	}
	// Remove own old relations first.
	for k := range sets {
		if old, ok := k2v[k]; ok {
			delete(v2k, old)
			delete(k2v, k)
		}
	}
	for k := range dels {
		if old, ok := k2v[k]; ok {
			delete(v2k, old)
			delete(k2v, k)
		}
	}
	// Check.
	seen := make(map[int]string, len(sets))
	for k, v := range sets {
		if _, dup := seen[v]; dup {
			return false
		}
		seen[v] = k
		if _, ok := k2v[k]; ok {
			return false
		}
		if _, ok := v2k[v]; ok {
			return false
		}
	}
	// Apply.
	for k, v := range sets {
		k2v[k] = v
		v2k[v] = k
	}
	md.k2v, md.v2k = k2v, v2k
	return true
}

func checkAgainstModel(t *testing.T, m *BiMap[string, int], md *model) {
	t.Helper()
	if m.Len() != len(md.k2v) {
		t.Fatalf("Len = %d, model = %d", m.Len(), len(md.k2v))
	}
	for k, v := range md.k2v {
		got, ok := m.Get(k)
		if !ok || got != v {
			t.Fatalf("Get(%q) = %v, %v; model wants %d", k, got, ok, v)
		}
		rk, ok := m.GetByValue(v)
		if !ok || rk != k {
			t.Fatalf("GetByValue(%d) = %q, %v; model wants %q", v, rk, ok, k)
		}
	}
	// Bijection: value count equals key count.
	if len(md.k2v) != len(md.v2k) {
		t.Fatalf("model broken: %d keys vs %d values", len(md.k2v), len(md.v2k))
	}
}

// TestRandomBatchesAgainstModel replays random transaction batches against
// both the BiMap and the two-map model, requiring identical accept/reject
// decisions and identical contents after every commit. Every 10th batch is
// a forced three-cycle swap over live keys.
func TestRandomBatchesAgainstModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	m := New[string, int]()
	md := newModel()

	const batches = 500
	for batch := 0; batch < batches; batch++ {
		tx := m.Begin()
		sets := make(map[string]int)
		dels := make(map[string]bool)

		if batch%10 == 9 && len(md.k2v) >= 3 {
			// Forced three-cycle swap over three live keys.
			keys := make([]string, 0, len(md.k2v))
			for k := range md.k2v {
				keys = append(keys, k)
			}
			for i := len(keys) - 1; i > 0; i-- {
				j := rng.Intn(i + 1)
				keys[i], keys[j] = keys[j], keys[i]
			}
			a, b, c := keys[0], keys[1], keys[2]
			va, vb, vc := md.k2v[a], md.k2v[b], md.k2v[c]
			tx.Set(a, vb)
			tx.Set(b, vc)
			tx.Set(c, va)
			sets[a], sets[b], sets[c] = vb, vc, va
		} else {
			ops := 1 + rng.Intn(6)
			for i := 0; i < ops; i++ {
				key := fmt.Sprintf("k%d", rng.Intn(12))
				val := rng.Intn(12)
				switch rng.Intn(4) {
				case 0:
					tx.Delete(key)
					delete(sets, key)
					dels[key] = true
				default:
					tx.Set(key, val)
					sets[key] = val
					delete(dels, key)
				}
			}
		}

		err := m.Commit(tx)
		modelOK := md.commit(sets, dels)
		if (err == nil) != modelOK {
			t.Fatalf("batch %d: bimap err=%v but model ok=%v", batch, err, modelOK)
		}
		checkAgainstModel(t, m, md)

		// Every snapshot ever taken must still be readable.
		if _, ok := m.Snapshot(m.Version()); !ok {
			t.Fatalf("batch %d: current version snapshot missing", batch)
		}
	}

	// Final full sweep of reverse lookups for absent values too.
	for v := 0; v < 12; v++ {
		k, ok := m.GetByValue(v)
		mk, mok := md.v2k[v]
		if ok != mok || (ok && k != mk) {
			t.Fatalf("GetByValue(%d) = %q,%v; model %q,%v", v, k, ok, mk, mok)
		}
	}
}
