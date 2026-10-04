package sessionstore

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

// 重连取得递增代。
func TestReconnectIncrementsGeneration(t *testing.T) {
	s := NewStore()
	var prev uint64
	for i := 0; i < 5; i++ {
		sess := s.Connect()
		if sess.Generation() <= prev {
			t.Fatalf("generation not increasing: got %d, previous %d", sess.Generation(), prev)
		}
		if sess.Generation() != s.Generation() {
			t.Fatalf("session gen %d != store gen %d", sess.Generation(), s.Generation())
		}
		prev = sess.Generation()
	}
}

// 旧代在途请求到达存储时拒绝，且不改变状态。
func TestStaleGenerationRejected(t *testing.T) {
	s := NewStore()
	old := s.Connect()
	if r := old.Apply(1, Op{Set: true, Key: "k", Value: "committed"}); !r.OK {
		t.Fatalf("current-gen apply failed: %v", r.Err)
	}
	s.Connect() // reconnect: old session's generation is now stale

	r := old.Apply(2, Op{Set: true, Key: "k", Value: "stale-write"})
	if !errors.Is(r.Err, ErrStaleGeneration) {
		t.Fatalf("expected ErrStaleGeneration, got %v", r.Err)
	}
	if r.OK {
		t.Fatal("stale op reported OK")
	}
	if v, _ := s.Get("k"); v != "committed" {
		t.Fatalf("stale op mutated state: k=%q", v)
	}
}

// 重复当前序号返回原结果，且不重复应用。
func TestDuplicateSequenceReturnsOriginalResult(t *testing.T) {
	s := NewStore()
	sess := s.Connect()

	first := sess.Apply(7, Op{Set: true, Key: "k", Value: "v1"})
	if !first.OK {
		t.Fatalf("first apply failed: %v", first.Err)
	}
	// Same seq, different payload: must return the original result and
	// must not re-apply.
	dup := sess.Apply(7, Op{Set: true, Key: "k", Value: "v2"})
	if dup != first {
		t.Fatalf("duplicate seq returned %+v, want original %+v", dup, first)
	}
	if v, _ := s.Get("k"); v != "v1" {
		t.Fatalf("duplicate seq re-applied op: k=%q", v)
	}
	// A different seq is a new operation.
	if r := sess.Apply(8, Op{Set: true, Key: "k", Value: "v3"}); !r.OK {
		t.Fatalf("new seq rejected: %v", r.Err)
	}
	if v, _ := s.Get("k"); v != "v3" {
		t.Fatalf("new seq not applied: k=%q", v)
	}
}

// 断线不回滚已提交操作。
func TestDisconnectDoesNotRollback(t *testing.T) {
	s := NewStore()
	sess := s.Connect()
	for i := 0; i < 10; i++ {
		key := fmt.Sprintf("key-%d", i)
		if r := sess.Apply(uint64(i+1), Op{Set: true, Key: key, Value: "v"}); !r.OK {
			t.Fatalf("apply %d failed: %v", i, r.Err)
		}
	}
	// Simulate disconnect + reconnect.
	s.Connect()
	for i := 0; i < 10; i++ {
		if v, ok := s.Get(fmt.Sprintf("key-%d", i)); !ok || v != "v" {
			t.Fatalf("committed op rolled back after reconnect: key-%d=%q ok=%v", i, v, ok)
		}
	}
}

// 事件交错验收：重连后，每次结果与状态只来自当前代。
func TestInterleavedEvents(t *testing.T) {
	s := NewStore()

	gen1 := s.Connect()
	// gen1 commits some ops before the "disconnect".
	if r := gen1.Apply(1, Op{Set: true, Key: "a", Value: "gen1-a"}); !r.OK {
		t.Fatalf("gen1 apply failed: %v", r.Err)
	}
	if r := gen1.Apply(2, Op{Set: true, Key: "b", Value: "gen1-b"}); !r.OK {
		t.Fatalf("gen1 apply failed: %v", r.Err)
	}

	// Reconnect: gen2 becomes current. gen1 ops 3..5 are still "in flight".
	gen2 := s.Connect()

	// Interleave: gen2 op, late gen1 in-flight op, gen2 op, ...
	steps := []struct {
		sess   *Session
		seq    uint64
		op     Op
		wantOK bool
	}{
		{gen2, 1, Op{Set: true, Key: "a", Value: "gen2-a"}, true},
		{gen1, 3, Op{Set: true, Key: "a", Value: "gen1-late"}, false}, // stale in-flight
		{gen2, 2, Op{Set: true, Key: "c", Value: "gen2-c"}, true},
		{gen1, 4, Op{Set: false, Key: "b"}, false},                    // stale delete must not apply
		{gen2, 2, Op{Set: true, Key: "c", Value: "gen2-c-DUP"}, true}, // duplicate seq
		{gen1, 5, Op{Set: true, Key: "d", Value: "gen1-d"}, false},
		{gen2, 3, Op{Set: false, Key: "b"}, true}, // current gen deletes gen1's committed key
	}
	for i, st := range steps {
		r := st.sess.Apply(st.seq, st.op)
		if st.wantOK {
			if !r.OK {
				t.Fatalf("step %d: expected OK, got err %v", i, r.Err)
			}
		} else if !errors.Is(r.Err, ErrStaleGeneration) {
			t.Fatalf("step %d: expected ErrStaleGeneration, got %+v", i, r)
		}
	}

	// Final state reflects only committed gen1 ops (pre-disconnect) and
	// current-gen ops; every stale-gen in-flight op was rejected.
	want := map[string]string{
		"a": "gen2-a", // overwritten by current gen
		"c": "gen2-c", // duplicate seq did not overwrite with gen2-c-DUP
		// "b" deleted by current gen; "d" never written (stale).
	}
	if got := s.Snapshot(); fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		t.Fatalf("state = %v, want %v", got, want)
	}
}

// 并发交错：多代并发提交，只有当前代的操作生效，且结果一致。
func TestConcurrentGenerations(t *testing.T) {
	s := NewStore()
	stale := s.Connect()
	current := s.Connect()

	const n = 200
	var wg sync.WaitGroup
	errs := make(chan error, 2*n)

	// Stale generation floods the store with in-flight requests.
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < n; i++ {
			r := stale.Apply(uint64(i+1), Op{Set: true, Key: fmt.Sprintf("stale-%d", i), Value: "x"})
			if !errors.Is(r.Err, ErrStaleGeneration) {
				errs <- fmt.Errorf("stale seq %d: got %+v", i, r)
			}
		}
	}()
	// Current generation applies ops; each is also duplicated and must
	// return the identical original result.
	go func() {
		defer wg.Done()
		for i := 0; i < n; i++ {
			op := Op{Set: true, Key: fmt.Sprintf("cur-%d", i), Value: "y"}
			r1 := current.Apply(uint64(i+1), op)
			r2 := current.Apply(uint64(i+1), Op{Set: true, Key: op.Key, Value: "corrupt"})
			if !r1.OK || r2 != r1 {
				errs <- fmt.Errorf("current seq %d: r1=%+v r2=%+v", i, r1, r2)
			}
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}

	snap := s.Snapshot()
	if len(snap) != n {
		t.Fatalf("state has %d keys, want %d (only current generation)", len(snap), n)
	}
	for i := 0; i < n; i++ {
		if v, ok := snap[fmt.Sprintf("cur-%d", i)]; !ok || v != "y" {
			t.Fatalf("cur-%d = %q ok=%v", i, v, ok)
		}
		if _, ok := snap[fmt.Sprintf("stale-%d", i)]; ok {
			t.Fatalf("stale-%d leaked into state", i)
		}
	}
}
