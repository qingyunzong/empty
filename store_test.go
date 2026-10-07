package txnkv

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// seed commits initial shards through the transactional path.
func seed(t *testing.T, s *Store, kvs ...string) {
	t.Helper()
	if len(kvs)%2 != 0 {
		t.Fatal("seed requires key/value pairs")
	}
	tx := s.Begin()
	for i := 0; i < len(kvs); i += 2 {
		tx.Set(kvs[i], kvs[i+1])
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
}

// barrier blocks the first Commit's preCommit hook until released; later
// hook invocations pass through so other transactions can commit meanwhile.
type barrier struct {
	armed   atomic.Bool
	entered chan struct{}
	release chan struct{}
}

func newBarrier() *barrier {
	b := &barrier{entered: make(chan struct{}), release: make(chan struct{})}
	b.armed.Store(true)
	return b
}

func (b *barrier) hook() func() {
	return func() {
		if b.armed.CompareAndSwap(true, false) {
			close(b.entered)
			<-b.release
		}
	}
}

func TestWriteSameValueStillIncrementsVersion(t *testing.T) {
	s := NewStore()

	tx := s.Begin()
	tx.Set("k", "v")
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if v, ok := s.Version("k"); !ok || v != 1 {
		t.Fatalf("after first write: version=%d ok=%v, want 1", v, ok)
	}

	// Rewrite the identical value: version must still advance.
	tx = s.Begin()
	tx.Set("k", "v")
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	snap := s.Snapshot()
	if snap["k"].Value != "v" || snap["k"].Version != 2 {
		t.Fatalf("same-value rewrite: got %+v, want value=v version=2", snap["k"])
	}
}

func TestConflictFailsWithoutPartialWrite(t *testing.T) {
	s := NewStore()
	seed(t, s, "x", "0")

	bar := newBarrier()
	s.preCommit = bar.hook()
	defer func() { s.preCommit = nil }()

	// Txn A reads x and buffers writes to y and z.
	a := s.Begin()
	if _, ok := a.Get("x"); !ok {
		t.Fatal("x should exist")
	}
	a.Set("y", "1")
	a.Set("z", "2")

	errCh := make(chan error, 1)
	go func() { errCh <- a.Commit() }()

	<-bar.entered // A is inside Commit, about to validate.

	// Txn B commits a write to x, invalidating A's read set.
	b := s.Begin()
	b.Set("x", "99")
	if err := b.Commit(); err != nil {
		t.Fatalf("B commit: %v", err)
	}
	close(bar.release)

	if err := <-errCh; !errors.Is(err, ErrConflict) {
		t.Fatalf("A commit: got %v, want ErrConflict", err)
	}

	// A failed: none of its writes may be visible.
	snap := s.Snapshot()
	if _, ok := snap["y"]; ok {
		t.Fatalf("partial write leaked: y=%v", snap["y"])
	}
	if _, ok := snap["z"]; ok {
		t.Fatalf("partial write leaked: z=%v", snap["z"])
	}
	if snap["x"].Value != "99" || snap["x"].Version != 2 {
		t.Fatalf("x: got %+v, want value=99 version=2", snap["x"])
	}
}

func TestReadOnlyTxnIsValidated(t *testing.T) {
	s := NewStore()
	seed(t, s, "x", "0")

	bar := newBarrier()
	s.preCommit = bar.hook()
	defer func() { s.preCommit = nil }()

	ro := s.Begin()
	ro.Get("x")

	errCh := make(chan error, 1)
	go func() { errCh <- ro.Commit() }()

	<-bar.entered
	w := s.Begin()
	w.Set("x", "1")
	if err := w.Commit(); err != nil {
		t.Fatalf("writer commit: %v", err)
	}
	close(bar.release)

	if err := <-errCh; !errors.Is(err, ErrConflict) {
		t.Fatalf("read-only commit: got %v, want ErrConflict", err)
	}

	// A read-only txn with no intervening writer commits fine.
	ro2 := s.Begin()
	ro2.Get("x")
	if err := ro2.Commit(); err != nil {
		t.Fatalf("clean read-only commit: %v", err)
	}
}

// TestInterleavedMatchesSerial forces B to commit between A's read and A's
// validation, retries A, and checks the final state equals the serial
// execution B -> A on a reference store.
func TestInterleavedMatchesSerial(t *testing.T) {
	s := NewStore()
	seed(t, s, "x", "10", "y", "20")

	bar := newBarrier()
	s.preCommit = bar.hook()

	// A: y = x + 1 (read-modify-write).
	a := s.Begin()
	xv, _ := a.Get("x")
	xn, _ := strconv.Atoi(xv)
	a.Set("y", strconv.Itoa(xn+1))

	errCh := make(chan error, 1)
	go func() { errCh <- a.Commit() }()

	<-bar.entered
	// B: x = 99, committed while A is mid-commit.
	b := s.Begin()
	b.Set("x", "99")
	if err := b.Commit(); err != nil {
		t.Fatalf("B commit: %v", err)
	}
	close(bar.release)

	if err := <-errCh; !errors.Is(err, ErrConflict) {
		t.Fatalf("A first attempt: got %v, want ErrConflict", err)
	}
	s.preCommit = nil

	// Retry A: now it must observe B's write.
	a = s.Begin()
	xv, _ = a.Get("x")
	xn, _ = strconv.Atoi(xv)
	a.Set("y", strconv.Itoa(xn+1))
	if err := a.Commit(); err != nil {
		t.Fatalf("A retry: %v", err)
	}

	// Serial reference: apply B then A on a fresh store.
	ref := NewStore()
	seed(t, ref, "x", "10", "y", "20")
	rb := ref.Begin()
	rb.Set("x", "99")
	if err := rb.Commit(); err != nil {
		t.Fatal(err)
	}
	ra := ref.Begin()
	rx, _ := ra.Get("x")
	rn, _ := strconv.Atoi(rx)
	ra.Set("y", strconv.Itoa(rn+1))
	if err := ra.Commit(); err != nil {
		t.Fatal(err)
	}

	got, want := s.Snapshot(), ref.Snapshot()
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		t.Fatalf("interleaved result %v != serial reference %v", got, want)
	}
	if got["y"].Value != "100" {
		t.Fatalf("y=%q, want 100 (A must see B's x=99 after retry)", got["y"].Value)
	}
}

// TestConcurrentIncrements runs N racing increment transactions with retry.
// The committed observations must be exactly 0..N-1 (each commit sees a
// state reachable by some serial order) and the final version must equal N.
func TestConcurrentIncrements(t *testing.T) {
	s := NewStore()
	const n = 64

	observed := make(chan int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				tx := s.Begin()
				raw, ok := tx.Get("c")
				cur := 0
				if ok {
					cur, _ = strconv.Atoi(raw)
				}
				tx.Set("c", strconv.Itoa(cur+1))
				if err := tx.Commit(); err == nil {
					observed <- cur
					return
				} else if !errors.Is(err, ErrConflict) {
					t.Errorf("unexpected commit error: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(observed)

	var vals []int
	for v := range observed {
		vals = append(vals, v)
	}
	sort.Ints(vals)
	if len(vals) != n {
		t.Fatalf("committed %d txns, want %d", len(vals), n)
	}
	for i, v := range vals {
		if v != i {
			t.Fatalf("observed values %v are not a serial permutation of 0..%d", vals, n-1)
		}
	}
	snap := s.Snapshot()
	if snap["c"].Value != strconv.Itoa(n) || snap["c"].Version != n {
		t.Fatalf("final: got %+v, want value=%d version=%d", snap["c"], n, n)
	}
}

// TestAtomicPublishVisibility hammers the store with two-shard commits while
// readers take snapshots; a snapshot must never show one shard updated
// without the other.
func TestAtomicPublishVisibility(t *testing.T) {
	s := NewStore()
	seed(t, s, "a", "0", "b", "0")

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				snap := s.Snapshot()
				if snap["a"].Value != snap["b"].Value {
					t.Errorf("torn read: a=%q b=%q", snap["a"].Value, snap["b"].Value)
					return
				}
			}
		}()
	}

	for i := 1; i <= 200; i++ {
		tx := s.Begin()
		v := strconv.Itoa(i)
		tx.Set("a", v)
		tx.Set("b", v)
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
	}
	close(stop)
	wg.Wait()
}
