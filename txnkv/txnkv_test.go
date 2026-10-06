package txnkv

import (
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
)

// barrier is a reusable rendezvous for exactly n goroutines, used to
// force deterministic interleavings between concurrent transactions.
type barrier struct {
	mu    sync.Mutex
	cond  *sync.Cond
	n     int
	count int
	gen   int
}

func newBarrier(n int) *barrier {
	b := &barrier{n: n}
	b.cond = sync.NewCond(&b.mu)
	return b
}

func (b *barrier) wait() {
	b.mu.Lock()
	gen := b.gen
	b.count++
	if b.count == b.n {
		b.gen++
		b.count = 0
		b.cond.Broadcast()
	} else {
		for gen == b.gen {
			b.cond.Wait()
		}
	}
	b.mu.Unlock()
}

func seed(t *testing.T, s *Store, kv map[string]string) {
	t.Helper()
	tx := s.Begin()
	for k, v := range kv {
		tx.Set(k, v)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
}

func TestCommitPublishesAndBumpsVersion(t *testing.T) {
	s := NewStore()
	tx := s.Begin()
	tx.Set("a", "1")
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	v, ver, ok := s.Load("a")
	if !ok || v != "1" || ver != 1 {
		t.Fatalf("got (%q,%d,%v), want (\"1\",1,true)", v, ver, ok)
	}
}

func TestSameValueWriteStillBumpsVersion(t *testing.T) {
	s := NewStore()
	seed(t, s, map[string]string{"a": "x"})
	before := s.Version("a")

	tx := s.Begin()
	tx.Set("a", "x") // identical value
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got := s.Version("a"); got != before+1 {
		t.Fatalf("same-value write: version %d, want %d", got, before+1)
	}
	if v, _, _ := s.Load("a"); v != "x" {
		t.Fatalf("value changed to %q", v)
	}
}

func TestConflictAbortsWithoutPartialWrites(t *testing.T) {
	s := NewStore()
	seed(t, s, map[string]string{"a": "0", "b": "0"})

	// T1 reads "a", then T2 modifies "a" and commits.
	t1 := s.Begin()
	if _, _, _ = t1.Get("a"); false {
	}
	t2 := s.Begin()
	t2.Set("a", "2")
	if err := t2.Commit(); err != nil {
		t.Fatalf("t2 commit: %v", err)
	}

	// T1 stages writes to two shards; commit must fail and publish nothing.
	t1.Set("a", "1")
	t1.Set("b", "1")
	err := t1.Commit()
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("t1 commit = %v, want ErrConflict", err)
	}
	if v, _, _ := s.Load("a"); v != "2" {
		t.Fatalf("partial write on a: %q", v)
	}
	if v, _, _ := s.Load("b"); v != "0" {
		t.Fatalf("partial write on b: %q", v)
	}
}

func TestReadOnlyTxnValidates(t *testing.T) {
	s := NewStore()
	seed(t, s, map[string]string{"a": "0", "b": "0"})

	// Read-only txn that sees a stable store commits fine.
	ro := s.Begin()
	ro.Get("a")
	ro.Get("b")
	if err := ro.Commit(); err != nil {
		t.Fatalf("read-only commit on stable store: %v", err)
	}

	// Read-only txn whose read shard changes underneath it must fail.
	ro2 := s.Begin()
	ro2.Get("a")
	w := s.Begin()
	w.Set("a", "9")
	if err := w.Commit(); err != nil {
		t.Fatalf("writer commit: %v", err)
	}
	if err := ro2.Commit(); !errors.Is(err, ErrConflict) {
		t.Fatalf("read-only commit = %v, want ErrConflict", err)
	}
}

func TestReadOnlyTxnDetectsTornSnapshot(t *testing.T) {
	s := NewStore()
	seed(t, s, map[string]string{"a": "0", "b": "0"})
	bar := newBarrier(2)

	// ro reads "a", then a writer commits changes to both shards, then ro
	// reads "b": ro observed a torn (non-serializable) snapshot and its
	// commit must fail validation.
	ro := s.Begin()
	ro.Get("a")

	go func() {
		bar.wait()
		w := s.Begin()
		w.Set("a", "1")
		w.Set("b", "1")
		_ = w.Commit()
		bar.wait()
	}()

	bar.wait() // let the writer run between ro's two reads
	bar.wait()
	ro.Get("b")
	if err := ro.Commit(); !errors.Is(err, ErrConflict) {
		t.Fatalf("torn read-only commit = %v, want ErrConflict", err)
	}
}

// TestBarrierInterleaveMatchesSerial forces two read-modify-write
// transactions to both read before either commits. Exactly one may win
// the first commit round; the loser retries. The final store state must
// equal the result of one of the two serial orders.
func TestBarrierInterleaveMatchesSerial(t *testing.T) {
	s := NewStore()
	seed(t, s, map[string]string{"a": "100", "b": "100"})
	bar := newBarrier(2)

	// transfer moves amt from->to using read-modify-write, retrying on
	// conflict. afterFirstRead runs once after the first attempt's reads.
	transfer := func(from, to string, amt int, afterFirstRead func()) error {
		first := true
		for {
			tx := s.Begin()
			fv, _, _ := tx.Get(from)
			tv, _, _ := tx.Get(to)
			if first {
				first = false
				if afterFirstRead != nil {
					afterFirstRead()
				}
			}
			f, _ := strconv.Atoi(fv)
			tv2, _ := strconv.Atoi(tv)
			tx.Set(from, strconv.Itoa(f-amt))
			tx.Set(to, strconv.Itoa(tv2+amt))
			if err := tx.Commit(); err == nil {
				return nil
			} else if !errors.Is(err, ErrConflict) {
				return err
			}
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		// T1: move 10 from a to b; pause after reads so T2 also reads.
		if err := transfer("a", "b", 10, bar.wait); err != nil {
			t.Errorf("t1: %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		// T2: move 20 from b to a; pause after reads so T1 also reads.
		if err := transfer("b", "a", 20, bar.wait); err != nil {
			t.Errorf("t2: %v", err)
		}
	}()
	wg.Wait()

	// Serial order T1->T2: a=100-10+20=110, b=100+10-20=90.
	// Serial order T2->T1: a=100+20-10=110, b=100-20+10=90. Identical here,
	// so also assert the invariant and exact versions (2 writes each).
	a, va, _ := s.Load("a")
	b, vb, _ := s.Load("b")
	ai, _ := strconv.Atoi(a)
	bi, _ := strconv.Atoi(b)
	if ai+bi != 200 {
		t.Fatalf("invariant broken: a=%d b=%d", ai, bi)
	}
	if a != "110" || b != "90" {
		t.Fatalf("final state (%s,%s) matches no serial order", a, b)
	}
	if va != 3 || vb != 3 { // seed=1, one write per committed txn
		t.Fatalf("versions (%d,%d), want (3,3)", va, vb)
	}
}

// TestConcurrentIncrementsAreSerializable runs many racing increment
// transactions; the final value and version must equal the number of
// committed increments — no lost updates, no extra bumps.
func TestConcurrentIncrementsAreSerializable(t *testing.T) {
	s := NewStore()
	seed(t, s, map[string]string{"n": "0"})
	const workers = 32
	const each = 25

	var wg sync.WaitGroup
	start := make(chan struct{})
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := 0; i < each; i++ {
				for {
					tx := s.Begin()
					v, _, _ := tx.Get("n")
					n, _ := strconv.Atoi(v)
					tx.Set("n", strconv.Itoa(n+1))
					if err := tx.Commit(); err == nil {
						break
					} else if !errors.Is(err, ErrConflict) {
						t.Errorf("commit: %v", err)
						return
					}
				}
			}
		}()
	}
	close(start)
	wg.Wait()

	want := workers * each
	v, ver, _ := s.Load("n")
	if v != strconv.Itoa(want) {
		t.Fatalf("value %q, want %d (lost update?)", v, want)
	}
	if ver != uint64(want)+1 { // +1 for the seed commit
		t.Fatalf("version %d, want %d", ver, want+1)
	}
}

func TestWriteSkewPrevented(t *testing.T) {
	// Two guards, constraint: at least one on duty. Each txn reads both
	// and sets its own to off. Interleaved via barrier, at most one may
	// commit; the loser must see ErrConflict and not retry here.
	s := NewStore()
	seed(t, s, map[string]string{"g1": "on", "g2": "on"})
	bar := newBarrier(2)

	results := make(chan error, 2)
	for _, me := range []string{"g1", "g2"} {
		me := me
		other := "g2"
		if me == "g2" {
			other = "g1"
		}
		go func() {
			tx := s.Begin()
			ov, _, _ := tx.Get(other)
			bar.wait() // both have read before either commits
			if ov == "on" {
				tx.Set(me, "off")
			}
			results <- tx.Commit()
		}()
	}
	e1, e2 := <-results, <-results
	committed := 0
	for _, e := range []error{e1, e2} {
		if e == nil {
			committed++
		} else if !errors.Is(e, ErrConflict) {
			t.Fatalf("unexpected error: %v", e)
		}
	}
	if committed != 1 {
		t.Fatalf("%d txns committed, want exactly 1", committed)
	}
	snap := s.Snapshot()
	if snap["g1"] == "off" && snap["g2"] == "off" {
		t.Fatalf("constraint violated: %v", snap)
	}
}

func Example() {
	s := NewStore()
	tx := s.Begin()
	tx.Set("hello", "world")
	if err := tx.Commit(); err != nil {
		panic(err)
	}
	v, ver, _ := s.Load("hello")
	fmt.Printf("%s v%d\n", v, ver)
	// Output: world v1
}
