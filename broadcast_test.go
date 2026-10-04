package broadcast

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

// drain collects every message until the subscription channel closes.
func drain[T any](s *Subscription[T]) []T {
	var out []T
	for v := range s.C() {
		out = append(out, v)
	}
	return out
}

func mustSubscribe(t *testing.T, b *Broker[int], buf int) *Subscription[int] {
	t.Helper()
	s, err := b.Subscribe(buf)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	return s
}

func TestPublishDeliversToAllInOrder(t *testing.T) {
	b := New[int]()
	subs := make([]*Subscription[int], 3)
	for i := range subs {
		subs[i] = mustSubscribe(t, b, 8)
	}
	if err := b.Publish(1, 2, 3); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if err := b.Publish(4); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	b.Close()
	for i, s := range subs {
		got := drain(s)
		want := []int{1, 2, 3, 4}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("sub %d got %v, want %v", i, got, want)
		}
		if !errors.Is(s.Err(), ErrClosed) {
			t.Errorf("sub %d reason = %v, want ErrClosed", i, s.Err())
		}
	}
}

func TestFullBufferEvictsOnlyThatSubscription(t *testing.T) {
	b := New[int]()
	fast := mustSubscribe(t, b, 8)
	slow := mustSubscribe(t, b, 2) // never drained

	if err := b.Publish(1, 2); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	// slow's buffer is now full; the next batch must evict only slow.
	if err := b.Publish(3); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got := drain(slow); fmt.Sprint(got) != fmt.Sprint([]int{1, 2}) {
		t.Errorf("slow got %v, want [1 2]", got)
	}
	if !errors.Is(slow.Err(), ErrBufferFull) {
		t.Errorf("slow reason = %v, want ErrBufferFull", slow.Err())
	}
	if fast.Err() != nil {
		t.Errorf("fast terminated early: %v", fast.Err())
	}
	b.Close()
	if got := drain(fast); fmt.Sprint(got) != fmt.Sprint([]int{1, 2, 3}) {
		t.Errorf("fast got %v, want [1 2 3]", got)
	}
	if !errors.Is(fast.Err(), ErrClosed) {
		t.Errorf("fast reason = %v, want ErrClosed", fast.Err())
	}
}

func TestBatchIsAllOrNothing(t *testing.T) {
	b := New[int]()
	big := mustSubscribe(t, b, 8)
	small := mustSubscribe(t, b, 2)

	if err := b.Publish(1, 2); err != nil { // exactly fills small
		t.Fatalf("Publish: %v", err)
	}
	// small cannot hold the whole 3-message batch, so it is evicted
	// before any of it is delivered; big must receive all of it.
	if err := b.Publish(3, 4, 5); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	b.Close()

	if got := drain(small); fmt.Sprint(got) != fmt.Sprint([]int{1, 2}) {
		t.Errorf("small got %v: partial batch leaked, want [1 2]", got)
	}
	if !errors.Is(small.Err(), ErrBufferFull) {
		t.Errorf("small reason = %v, want ErrBufferFull", small.Err())
	}
	if got := drain(big); fmt.Sprint(got) != fmt.Sprint([]int{1, 2, 3, 4, 5}) {
		t.Errorf("big got %v, want [1 2 3 4 5]", got)
	}
}

func TestBatchLargerThanCapacityEvictsImmediately(t *testing.T) {
	b := New[int]()
	tiny := mustSubscribe(t, b, 1)
	roomy := mustSubscribe(t, b, 4)

	if err := b.Publish(1, 2, 3); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	b.Close()
	if got := drain(tiny); len(got) != 0 {
		t.Errorf("tiny got %v, want nothing", got)
	}
	if !errors.Is(tiny.Err(), ErrBufferFull) {
		t.Errorf("tiny reason = %v, want ErrBufferFull", tiny.Err())
	}
	if got := drain(roomy); fmt.Sprint(got) != fmt.Sprint([]int{1, 2, 3}) {
		t.Errorf("roomy got %v, want [1 2 3]", got)
	}
}

func TestCloseAndPublishAfterClose(t *testing.T) {
	b := New[int]()
	s := mustSubscribe(t, b, 4)
	if err := b.Publish(1); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	b.Close()
	b.Close() // idempotent
	if err := b.Publish(2); !errors.Is(err, ErrClosed) {
		t.Errorf("Publish after Close = %v, want ErrClosed", err)
	}
	if _, err := b.Subscribe(1); !errors.Is(err, ErrClosed) {
		t.Errorf("Subscribe after Close = %v, want ErrClosed", err)
	}
	if got := drain(s); fmt.Sprint(got) != fmt.Sprint([]int{1}) {
		t.Errorf("got %v, want [1]", got)
	}
	if !errors.Is(s.Err(), ErrClosed) {
		t.Errorf("reason = %v, want ErrClosed", s.Err())
	}
}

func TestUnsubscribe(t *testing.T) {
	b := New[int]()
	s := mustSubscribe(t, b, 4)
	other := mustSubscribe(t, b, 4)
	s.Unsubscribe()
	if !errors.Is(s.Err(), ErrUnsubscribed) {
		t.Errorf("reason = %v, want ErrUnsubscribed", s.Err())
	}
	if err := b.Publish(7); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	b.Close()
	if got := drain(s); len(got) != 0 {
		t.Errorf("unsubscribed sub got %v, want nothing", got)
	}
	if got := drain(other); fmt.Sprint(got) != fmt.Sprint([]int{7}) {
		t.Errorf("other got %v, want [7]", got)
	}
}

// TestConcurrentPublishCloseContiguousPrefix interleaves many publishers
// with Close and verifies, via per-publisher sequence numbers, that every
// subscription observes a contiguous prefix of each publisher's accepted
// stream: no gaps, no duplicates, no reordering.
func TestConcurrentPublishCloseContiguousPrefix(t *testing.T) {
	type msg struct{ pub, seq int }

	const publishers = 4
	const perPublisher = 500

	b := New[msg]()
	const subs = 3
	streams := make([][]msg, subs)
	var wg sync.WaitGroup
	for i := 0; i < subs; i++ {
		s, err := b.Subscribe(publishers * perPublisher)
		if err != nil {
			t.Fatalf("Subscribe: %v", err)
		}
		wg.Add(1)
		go func(i int, s *Subscription[msg]) {
			defer wg.Done()
			for m := range s.C() {
				streams[i] = append(streams[i], m)
			}
		}(i, s)
	}

	var pubWg sync.WaitGroup
	for p := 0; p < publishers; p++ {
		pubWg.Add(1)
		go func(p int) {
			defer pubWg.Done()
			for seq := 0; seq < perPublisher; seq++ {
				if err := b.Publish(msg{p, seq}); errors.Is(err, ErrClosed) {
					return
				}
			}
		}(p)
	}
	// Close at an arbitrary interleaving point.
	go b.Close()
	pubWg.Wait()
	wg.Wait()

	for i, stream := range streams {
		next := make([]int, publishers)
		for _, m := range stream {
			if m.seq != next[m.pub] {
				t.Fatalf("sub %d: pub %d seq %d, want %d (gap/dup/reorder)",
					i, m.pub, m.seq, next[m.pub])
			}
			next[m.pub]++
		}
		t.Logf("sub %d received contiguous prefixes: %v", i, next)
	}
}

// TestConcurrentSlowSubscriberEvicted verifies that a non-reading
// subscriber is evicted with ErrBufferFull under concurrent load while
// drained subscribers keep receiving contiguous prefixes until Close.
func TestConcurrentSlowSubscriberEvicted(t *testing.T) {
	b := New[int]()
	slow := mustSubscribe(t, b, 4)
	fast := mustSubscribe(t, b, 1<<16)

	done := make(chan []int, 1)
	go func() { done <- drain(fast) }()

	seq := 0
	for slow.Err() == nil {
		if err := b.Publish(seq); errors.Is(err, ErrClosed) {
			break
		}
		seq++
	}
	if !errors.Is(slow.Err(), ErrBufferFull) {
		t.Fatalf("slow reason = %v, want ErrBufferFull", slow.Err())
	}
	slowGot := drain(slow)
	for i, v := range slowGot {
		if v != i {
			t.Fatalf("slow stream not a contiguous prefix: index %d = %d", i, v)
		}
	}

	for i := 0; i < 10; i++ {
		if err := b.Publish(seq); err != nil {
			t.Fatalf("Publish after eviction: %v", err)
		}
		seq++
	}
	b.Close()

	fastGot := <-done
	if len(fastGot) != seq {
		t.Fatalf("fast got %d messages, want %d", len(fastGot), seq)
	}
	for i, v := range fastGot {
		if v != i {
			t.Fatalf("fast stream not a contiguous prefix: index %d = %d", i, v)
		}
	}
	if !errors.Is(fast.Err(), ErrClosed) {
		t.Errorf("fast reason = %v, want ErrClosed", fast.Err())
	}
}
