package broadcast

import (
	"sync"
	"testing"
	"time"
)

// barrier returns wait/release closures; release unblocks all waiters at
// roughly the same time so goroutines interleave from a common start line.
func barrier() (wait func(), release func()) {
	start := make(chan struct{})
	return func() { <-start }, func() { close(start) }
}

func mustNext(t *testing.T, s *Subscription) any {
	t.Helper()
	m, err := s.Next()
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	return m
}

func TestBasicOrderNoDupNoGap(t *testing.T) {
	b := New(4)
	s := b.Subscribe()
	const n = 3
	for i := 0; i < n; i++ {
		if err := b.Send(i); err != nil {
			t.Fatalf("Send: %v", err)
		}
	}
	for i := 0; i < n; i++ {
		if got := mustNext(t, s); got != i {
			t.Fatalf("got %v, want %d", got, i)
		}
	}
}

func TestBackpressureBlocksOnSlowReader(t *testing.T) {
	b := New(2)
	fast := b.Subscribe()
	slow := b.Subscribe()

	if err := b.Send(0); err != nil {
		t.Fatal(err)
	}
	if err := b.Send(1); err != nil {
		t.Fatal(err)
	}
	// Buffer full, slow reader has read nothing: third Send must block.
	done := make(chan error, 1)
	go func() { done <- b.Send(2) }()
	select {
	case <-done:
		t.Fatal("Send did not block while slow reader was behind")
	case <-time.After(50 * time.Millisecond):
	}

	// Fast reader alone cannot unblock: slow cursor is the constraint.
	if got := mustNext(t, fast); got != 0 {
		t.Fatalf("got %v, want 0", got)
	}
	if got := mustNext(t, fast); got != 1 {
		t.Fatalf("got %v, want 1", got)
	}
	select {
	case <-done:
		t.Fatal("Send unblocked although slow reader still lags")
	case <-time.After(50 * time.Millisecond):
	}

	// Slow reader advances: publisher unblocks.
	if got := mustNext(t, slow); got != 0 {
		t.Fatalf("got %v, want 0", got)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Send still blocked after slow reader advanced")
	}
}

func TestUnsubscribeRemovesBackpressureImmediately(t *testing.T) {
	b := New(2)
	slow := b.Subscribe()

	_ = b.Send(0)
	_ = b.Send(1)
	done := make(chan error, 1)
	go func() { done <- b.Send(2) }()
	select {
	case <-done:
		t.Fatal("Send did not block")
	case <-time.After(50 * time.Millisecond):
	}

	slow.Unsubscribe()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Send still blocked after Unsubscribe")
	}
	if _, err := slow.Next(); err != ErrClosed {
		t.Fatalf("Next after Unsubscribe: %v", err)
	}
}

func TestCloseDrainsPublishedMessages(t *testing.T) {
	b := New(8)
	s := b.Subscribe()
	for i := 0; i < 5; i++ {
		_ = b.Send(i)
	}
	b.Close()

	if err := b.Send(99); err != ErrClosed {
		t.Fatalf("Send after Close: %v", err)
	}
	for i := 0; i < 5; i++ {
		if got := mustNext(t, s); got != i {
			t.Fatalf("got %v, want %d", got, i)
		}
	}
	if _, err := s.Next(); err != ErrClosed {
		t.Fatalf("Next after drain: %v", err)
	}
}

func TestNoSubscriberNoBackpressure(t *testing.T) {
	b := New(2)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			_ = b.Send(i)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Send blocked with no subscribers")
	}
}

// TestBarrierInterleaved releases one publisher and several subscribers
// from a common barrier so Send, Next and Unsubscribe interleave, then
// verifies every subscriber observed a strictly contiguous sequence with
// no duplicates and no gaps.
func TestBarrierInterleaved(t *testing.T) {
	const (
		subs     = 6
		msgs     = 2000
		capacity = 8
		cancelAt = msgs / 2 // last subscriber cancels mid-stream
	)
	b := New(capacity)
	wait, release := barrier()

	results := make([][]int, subs)
	var wg sync.WaitGroup

	for i := 0; i < subs; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			s := b.Subscribe()
			wait()
			cancel := idx == subs-1
			for {
				m, err := s.Next()
				if err == ErrClosed {
					return
				}
				if err != nil {
					t.Errorf("sub %d Next: %v", idx, err)
					return
				}
				results[idx] = append(results[idx], m.(int))
				if cancel && len(results[idx]) == cancelAt {
					s.Unsubscribe()
					return
				}
			}
		}(i)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		wait()
		for i := 0; i < msgs; i++ {
			if err := b.Send(i); err != nil {
				t.Errorf("Send(%d): %v", i, err)
				return
			}
		}
		b.Close()
	}()

	// Let every goroutine reach the barrier, then release them together.
	time.Sleep(10 * time.Millisecond)
	release()
	wg.Wait()

	for i := range results {
		seen := results[i]
		for j, v := range seen {
			// All subscribers subscribed before the barrier released, so
			// each must observe exactly 0,1,2,... with no dup or gap.
			if v != j {
				t.Errorf("sub %d: position %d = %d, want %d (dup or gap)", i, j, v, j)
				break
			}
		}
		want := msgs
		if i == subs-1 {
			want = cancelAt
		}
		if len(seen) != want {
			t.Errorf("sub %d saw %d messages, want %d", i, len(seen), want)
		}
	}
}
