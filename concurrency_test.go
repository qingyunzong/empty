package boolcov

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

// staticRead is a goroutine-safe Reader over a fixed value map.
func staticRead(vals map[string]bool) Reader {
	return func(name string) (bool, error) {
		v, ok := vals[name]
		if !ok {
			return false, errors.New("unknown var: " + name)
		}
		return v, nil
	}
}

// benchAST mixes short-circuit paths: (x && y) || (z && w).
func benchAST() *Node {
	return &Node{ID: "root", Kind: KindOr,
		Left: &Node{ID: "and1", Kind: KindAnd,
			Left:  &Node{ID: "x", Kind: KindVar, Name: "x"},
			Right: &Node{ID: "y", Kind: KindVar, Name: "y"},
		},
		Right: &Node{ID: "and2", Kind: KindAnd,
			Left:  &Node{ID: "z", Kind: KindVar, Name: "z"},
			Right: &Node{ID: "w", Kind: KindVar, Name: "w"},
		},
	}
}

// expectedVisits computes per-node counts for one evaluation via the
// reference evaluator, so concurrency tests assert exact multiples.
func expectedVisits(t *testing.T, root *Node, read Reader) map[string]uint64 {
	t.Helper()
	visits := map[string]uint64{}
	if _, err := refEval(root, read, visits); err != nil {
		t.Fatal(err)
	}
	return visits
}

func TestConcurrentSharedExecutorExactCounts(t *testing.T) {
	root := benchAST()
	tab := Freeze(root)
	ex := NewExecutor(tab)
	read := staticRead(map[string]bool{"x": false, "y": true, "z": true, "w": true})

	once := expectedVisits(t, root, read)
	const goroutines, iters = 16, 500
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				if _, err := ex.Eval(context.Background(), root, read); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()

	total := uint64(goroutines * iters)
	for id := range tab.Snapshot() {
		want := once[id] * total
		if got := tab.Count(id); got != want {
			t.Fatalf("count[%s]=%d, want %d (visits/eval %d x %d evals)", id, got, want, once[id], total)
		}
	}
}

func TestConcurrentShardsMerge(t *testing.T) {
	root := benchAST()
	tab := Freeze(root)
	ex := NewExecutor(tab)
	read := staticRead(map[string]bool{"x": true, "y": false, "z": true, "w": true})

	once := expectedVisits(t, root, read)
	const goroutines, iters = 8, 700
	shards := make([]*Executor, goroutines)
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		shards[g] = ex.Shard()
		wg.Add(1)
		go func(ex *Executor) {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				if _, err := ex.Eval(context.Background(), root, read); err != nil {
					t.Error(err)
					return
				}
			}
		}(shards[g])
	}
	wg.Wait()
	for _, s := range shards {
		tab.Merge(s.Table())
	}

	total := uint64(goroutines * iters)
	for id := range tab.Snapshot() {
		want := once[id] * total
		if got := tab.Count(id); got != want {
			t.Fatalf("merged count[%s]=%d, want %d", id, got, want)
		}
	}
}

// TestCancellationBarrierNoLostCounts races cancellation against in-flight
// evaluations. A barrier holds every goroutine inside its variable read;
// the context is cancelled while they are blocked. Every node entered
// before the cancel must keep its count.
func TestCancellationBarrierNoLostCounts(t *testing.T) {
	root := &Node{ID: "root", Kind: KindAnd,
		Left:  &Node{ID: "gate", Kind: KindVar, Name: "gate"},
		Right: &Node{ID: "tail", Kind: KindVar, Name: "tail"},
	}
	tab := Freeze(root)
	ex := NewExecutor(tab)

	const goroutines = 32
	ctx, cancel := context.WithCancel(context.Background())
	entered := make(chan struct{}, goroutines)
	release := make(chan struct{})
	var readsStarted atomic.Int64
	read := func(name string) (bool, error) {
		readsStarted.Add(1)
		entered <- struct{}{}
		<-release // hold until cancellation lands
		return true, nil
	}

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = ex.Eval(ctx, root, read)
		}()
	}
	// Barrier: wait until every goroutine is blocked inside its read.
	for i := 0; i < goroutines; i++ {
		<-entered
	}
	cancel()
	close(release)
	wg.Wait()

	// All goroutines passed through root and gate before the barrier;
	// none may have lost its already-started count.
	if got := tab.Count("root"); got != goroutines {
		t.Fatalf("root count=%d, want %d", got, goroutines)
	}
	if got := tab.Count("gate"); got != goroutines {
		t.Fatalf("gate count=%d, want %d", got, goroutines)
	}
	if got := readsStarted.Load(); got != goroutines {
		t.Fatalf("reads started=%d, want %d", got, goroutines)
	}
	// The tail may or may not have started before cancellation, but every
	// started tail must be counted: count is bounded by completed reads.
	if got := tab.Count("tail"); got > goroutines {
		t.Fatalf("tail count=%d exceeds goroutines=%d", got, goroutines)
	}
}

// TestVersionReplacementBarrier swaps the coverage table for a rewritten
// source version while evaluations are blocked at a barrier. Counts
// recorded into the old table before the swap must survive intact, and
// the migrated table must carry exactly the counts visible at swap time.
func TestVersionReplacementBarrier(t *testing.T) {
	v1 := astV1()
	oldTab := Freeze(v1)
	ex := NewExecutor(oldTab)
	read := staticRead(map[string]bool{"x": true, "y": true})

	// x=true, y=true: visits root, a, b, c per eval; d is short-circuited.
	once := expectedVisits(t, v1, read)
	const goroutines, iters = 8, 300

	var wg sync.WaitGroup
	start := make(chan struct{})
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := 0; i < iters; i++ {
				if _, err := ex.Eval(context.Background(), v1, read); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	close(start)
	wg.Wait()

	total := uint64(goroutines * iters)
	for id, per := range once {
		if got := oldTab.Count(id); got != per*total {
			t.Fatalf("pre-swap count[%s]=%d, want %d", id, got, per*total)
		}
	}

	// Version replacement: rename y -> z (c changes), keep the rest.
	v2 := &Node{ID: "root", Kind: KindAnd,
		Left: &Node{ID: "a", Kind: KindVar, Name: "x"},
		Right: &Node{ID: "b", Kind: KindOr,
			Left:  &Node{ID: "c", Kind: KindVar, Name: "z"},
			Right: &Node{ID: "d", Kind: KindConst, Value: true},
		},
	}
	newTab := oldTab.Migrate(v2)

	// Unchanged nodes carry the full pre-swap counts; changed node c resets.
	for _, id := range []string{"root", "a", "b"} {
		if got, want := newTab.Count(id), once[id]*total; got != want {
			t.Fatalf("migrated count[%s]=%d, want %d", id, got, want)
		}
	}
	if got := newTab.Count("c"); got != 0 {
		t.Fatalf("changed node c migrated count=%d, want 0", got)
	}
	// The old table is frozen: still holds every pre-swap count.
	for id, per := range once {
		if got := oldTab.Count(id); got != per*total {
			t.Fatalf("post-swap old count[%s]=%d, want %d", id, got, per*total)
		}
	}

	// Recording continues into the new table without disturbing the old.
	newEx := NewExecutor(newTab)
	read2 := staticRead(map[string]bool{"x": true, "z": true})
	if _, err := newEx.Eval(context.Background(), v2, read2); err != nil {
		t.Fatal(err)
	}
	if got, want := newTab.Count("root"), once["root"]*total+1; got != want {
		t.Fatalf("post-migration root count=%d, want %d", got, want)
	}
	if got := newTab.Count("c"); got != 1 {
		t.Fatalf("post-migration c count=%d, want 1", got)
	}
	if got := oldTab.Count("root"); got != once["root"]*total {
		t.Fatalf("old table disturbed: root=%d, want %d", got, once["root"]*total)
	}
}
