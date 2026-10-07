package indexrebuild

import (
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

// A rebuild with no concurrent writes must mirror the main table exactly.
func TestRebuildReflectsMainTable(t *testing.T) {
	e := NewEngine()
	for i := 0; i < 100; i++ {
		e.Put(fmt.Sprintf("k%03d", i), fmt.Sprintf("v%d", i))
	}
	e.Delete("k007")

	idx := e.Rebuild(nil)

	want := e.FullScan()
	if len(idx.data) != len(want) {
		t.Fatalf("index has %d keys, main table has %d", len(idx.data), len(want))
	}
	for k, v := range want {
		got, ok := idx.get(k)
		if !ok || got != v {
			t.Fatalf("key %q: index has (%q, %v), main table has %q", k, got, ok, v)
		}
	}
	if !e.ActiveMatchesMainTable() {
		t.Fatal("active index diverged from main table after switch")
	}
}

// Deletes committed during the rebuild must be replayed, not missed.
func TestDeleteDuringRebuildIsNotMissed(t *testing.T) {
	e := NewEngine()
	e.Put("victim", "x")
	e.Put("survivor", "y")

	hooks := &RebuildHooks{AfterBulkBuild: func() {
		// Land a delete and an insert after the freeze, mid-rebuild.
		e.Delete("victim")
		e.Put("fresh", "z")
	}}
	e.Rebuild(hooks)

	if _, ok := e.Get("victim"); ok {
		t.Fatal("delete committed during rebuild was missed by the new index")
	}
	if got, ok := e.Get("fresh"); !ok || got != "z" {
		t.Fatalf("insert committed during rebuild missing: got (%q, %v)", got, ok)
	}
	if got, ok := e.Get("survivor"); !ok || got != "y" {
		t.Fatalf("untouched key corrupted: got (%q, %v)", got, ok)
	}
	if !e.ActiveMatchesMainTable() {
		t.Fatal("active index diverged from main table after switch")
	}
}

// Until the atomic switch, queries must be routed to the old index object;
// the old index stays current via the live commit path while the new one is
// built in the background.
func TestQueriesUseOldIndexUntilSwitch(t *testing.T) {
	e := NewEngine()
	e.Put("a", "old")

	e.mu.RLock()
	oldIdx := e.active
	e.mu.RUnlock()

	hooks := &RebuildHooks{AfterBulkBuild: func() {
		// Mutate after the freeze; the switch has not happened yet.
		e.Put("a", "new")
		e.Put("b", "added")

		e.mu.RLock()
		serving := e.active
		e.mu.RUnlock()
		if serving != oldIdx {
			t.Error("queries were switched to the new index before the barrier")
		}
		// The old index is kept current by the live commit path, so
		// queries still see up-to-date data while the rebuild runs.
		if got, _ := e.Get("a"); got != "new" {
			t.Errorf("old index not live-updated: Get(a) = %q, want %q", got, "new")
		}
	}}
	idx := e.Rebuild(hooks)

	e.mu.RLock()
	serving := e.active
	e.mu.RUnlock()
	if serving == oldIdx {
		t.Fatal("atomic switch did not happen")
	}
	if serving != idx {
		t.Fatal("after switch, queries must be served by the rebuilt index")
	}
	if got, _ := e.Get("a"); got != "new" {
		t.Errorf("after switch, Get(a) = %q, want %q", got, "new")
	}
	if got, ok := e.Get("b"); !ok || got != "added" {
		t.Errorf("after switch, Get(b) = (%q, %v), want (%q, true)", got, ok, "added")
	}
}

// Stress the barrier: concurrent writers and readers interleaved with many
// rebuilds; after every switch the serving index must equal a full scan of
// the main table. Run with -race.
func TestRebuildUnderConcurrentWrites(t *testing.T) {
	e := NewEngine()
	const keys = 200
	for i := 0; i < keys; i++ {
		e.Put(fmt.Sprintf("k%03d", i), "initial")
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup

	// Writers: random puts and deletes over a shared key space.
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			r := rand.New(rand.NewSource(seed))
			for {
				select {
				case <-stop:
					return
				default:
				}
				key := fmt.Sprintf("k%03d", r.Intn(keys))
				if r.Intn(3) == 0 {
					e.Delete(key)
				} else {
					e.Put(key, fmt.Sprintf("w%d-%d", seed, r.Int()))
				}
			}
		}(int64(w + 1))
	}

	// Readers: queries must always be servable from the active index.
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			r := rand.New(rand.NewSource(seed))
			for {
				select {
				case <-stop:
					return
				default:
				}
				e.Get(fmt.Sprintf("k%03d", r.Intn(keys)))
			}
		}(int64(w + 100))
	}

	// Interleave rebuilds with the mutation stream; each switch must leave
	// the serving index identical to a full scan of the main table.
	for i := 0; i < 50; i++ {
		e.Rebuild(nil)
		if !e.ActiveMatchesMainTable() {
			t.Fatalf("rebuild %d: active index diverged from main table", i)
		}
	}

	close(stop)
	wg.Wait()

	if !e.ActiveMatchesMainTable() {
		t.Fatal("active index diverged from main table after final switch")
	}
}

// A rebuilt index must be consistent with the source version it claims:
// replaying the log again must be a no-op (idempotent apply).
func TestReplayIsIdempotent(t *testing.T) {
	e := NewEngine()
	e.Put("a", "1")
	e.Put("b", "2")
	e.Delete("a")

	idx := e.Rebuild(nil)
	v := idx.Version()
	for _, d := range e.deltas {
		idx.apply(d)
	}
	if idx.Version() != v {
		t.Fatalf("re-applying deltas moved version from %d to %d", v, idx.Version())
	}
	if _, ok := idx.get("a"); ok {
		t.Fatal("delete not reflected after idempotent replay")
	}
	if got, ok := idx.get("b"); !ok || got != "2" {
		t.Fatalf("b = (%q, %v), want (%q, true)", got, ok, "2")
	}
}
