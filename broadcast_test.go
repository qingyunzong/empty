package broadcast

import (
	"sync"
	"testing"
	"time"
)

// barrier synchronizes n goroutines: each call to wait blocks until all n
// have arrived, then all proceed together.
type barrier struct {
	n     int
	count int
	mu    sync.Mutex
	ch    chan struct{}
}

func newBarrier(n int) *barrier { return &barrier{n: n, ch: make(chan struct{})} }

func (b *barrier) wait() {
	b.mu.Lock()
	b.count++
	if b.count == b.n {
		close(b.ch)
	}
	ch := b.ch
	b.mu.Unlock()
	<-ch
}

func mustPublish(t *testing.T, b *Broadcast, v any, wantSeq uint64) {
	t.Helper()
	seq, err := b.Publish(v)
	if err != nil {
		t.Fatalf("Publish(%v) error: %v", v, err)
	}
	if seq != wantSeq {
		t.Fatalf("Publish(%v) seq = %d, want %d", v, seq, wantSeq)
	}
}

func mustRead(t *testing.T, s *Subscriber, wantSeq uint64, wantData any) {
	t.Helper()
	m, err := s.Read()
	if err != nil {
		t.Fatalf("Read error: %v", err)
	}
	if m.Seq != wantSeq || m.Data != wantData {
		t.Fatalf("Read = {%d %v}, want {%d %v}", m.Seq, m.Data, wantSeq, wantData)
	}
}

// TestPublishBlocksOnSlowReader verifies backpressure: with a full buffer and
// a subscriber that has not consumed the oldest message, Publish blocks until
// that subscriber reads.
func TestPublishBlocksOnSlowReader(t *testing.T) {
	b := New(2)
	s := b.Subscribe()
	mustPublish(t, b, "a", 0)
	mustPublish(t, b, "b", 1)

	done := make(chan struct{})
	go func() {
		defer close(done)
		b.Publish("c")
	}()

	select {
	case <-done:
		t.Fatal("Publish did not block behind slow reader")
	case <-time.After(50 * time.Millisecond):
	}

	mustRead(t, s, 0, "a") // frees the oldest slot

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish still blocked after reader advanced")
	}
	mustRead(t, s, 1, "b")
	mustRead(t, s, 2, "c")
}

// TestUnsubscribeUnblocksPublisher verifies that cancelling a slow subscriber
// immediately releases a blocked publisher.
func TestUnsubscribeUnblocksPublisher(t *testing.T) {
	b := New(1)
	s := b.Subscribe()
	mustPublish(t, b, "a", 0)

	done := make(chan uint64, 1)
	go func() {
		seq, err := b.Publish("b")
		if err != nil {
			t.Errorf("Publish error: %v", err)
		}
		done <- seq
	}()

	select {
	case <-done:
		t.Fatal("Publish did not block behind slow reader")
	case <-time.After(50 * time.Millisecond):
	}

	s.Unsubscribe() // must unblock the publisher without any Read

	select {
	case seq := <-done:
		if seq != 1 {
			t.Fatalf("seq = %d, want 1", seq)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Publish still blocked after Unsubscribe")
	}
}

// TestCloseDrainsPublished verifies that after Close, subscribers can still
// read everything published, then observe ErrClosed, and Publish fails.
func TestCloseDrainsPublished(t *testing.T) {
	b := New(4)
	s1 := b.Subscribe()
	s2 := b.Subscribe()
	for i := 0; i < 3; i++ {
		mustPublish(t, b, i, uint64(i))
	}
	s2.Unsubscribe()
	b.Close()

	if _, err := b.Publish("x"); err != ErrClosed {
		t.Fatalf("Publish after Close err = %v, want ErrClosed", err)
	}
	for i := 0; i < 3; i++ {
		mustRead(t, s1, uint64(i), i)
	}
	if _, err := s1.Read(); err != ErrClosed {
		t.Fatalf("Read after drain err = %v, want ErrClosed", err)
	}
}

// TestCloseUnblocksPublisher verifies Close releases a publisher blocked on
// backpressure with ErrClosed.
func TestCloseUnblocksPublisher(t *testing.T) {
	b := New(1)
	b.Subscribe() // never reads
	mustPublish(t, b, "a", 0)

	done := make(chan error, 1)
	go func() {
		_, err := b.Publish("b")
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	b.Close()

	select {
	case err := <-done:
		if err != ErrClosed {
			t.Fatalf("blocked Publish err = %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Publish still blocked after Close")
	}
}

// TestOverwriteWithoutReaders verifies the ring keeps only the last N
// messages when no subscriber needs the oldest ones, and sequence numbers
// stay monotonic with no reuse.
func TestOverwriteWithoutReaders(t *testing.T) {
	b := New(2)
	for i := 0; i < 5; i++ {
		mustPublish(t, b, i, uint64(i))
	}
	s := b.Subscribe() // cursor starts at the next message
	mustPublish(t, b, 5, 5)
	mustRead(t, s, 5, 5)
}

// TestIndependentCursors verifies subscribers read the same stream at
// independent paces without affecting each other.
func TestIndependentCursors(t *testing.T) {
	b := New(3)
	fast := b.Subscribe()
	slow := b.Subscribe()

	mustPublish(t, b, "x", 0)
	mustRead(t, fast, 0, "x")
	mustRead(t, slow, 0, "x")

	mustPublish(t, b, "y", 1)
	mustPublish(t, b, "z", 2)
	mustRead(t, fast, 1, "y")
	mustRead(t, fast, 2, "z")
	mustRead(t, slow, 1, "y")
	mustRead(t, slow, 2, "z")
}

// TestBarrierInterleaved uses barriers to force a deterministic interleaving
// of sends, reads, and a cancel, then checks every subscriber observed a
// contiguous, duplicate-free sequence.
func TestBarrierInterleaved(t *testing.T) {
	b := New(2)
	slow := b.Subscribe()
	steady := b.Subscribe()
	cancelled := b.Subscribe()

	// Phase 1: fill the buffer while all three subscribers hold cursors at 0.
	phase1 := newBarrier(2)
	go func() {
		phase1.wait()
		b.Publish("m0")
		b.Publish("m1")
	}()
	phase1.wait()

	// Phase 2: steady reads m0, but a concurrent publish of m2 must stay
	// blocked because slow and cancelled still need m0.
	phase2 := newBarrier(3)
	readDone := make(chan Message, 1)
	pubDone := make(chan uint64, 1)
	go func() {
		phase2.wait()
		m, _ := steady.Read()
		readDone <- m
	}()
	go func() {
		phase2.wait()
		seq, _ := b.Publish("m2")
		pubDone <- seq
	}()
	phase2.wait()

	m := <-readDone
	if m.Seq != 0 || m.Data != "m0" {
		t.Fatalf("steady first read = {%d %v}, want {0 m0}", m.Seq, m.Data)
	}
	select {
	case <-pubDone:
		t.Fatal("Publish(m2) should block: slow and cancelled still need m0")
	case <-time.After(50 * time.Millisecond):
	}

	// Phase 3: cancelling one blocker is not enough; slow still needs m0.
	cancelled.Unsubscribe()
	select {
	case <-pubDone:
		t.Fatal("Publish(m2) should block: slow still needs m0")
	case <-time.After(50 * time.Millisecond):
	}

	// Phase 4: slow reads m0, releasing the blocked publisher.
	mustRead(t, slow, 0, "m0")
	select {
	case seq := <-pubDone:
		if seq != 2 {
			t.Fatalf("m2 seq = %d, want 2", seq)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Publish(m2) still blocked after final reader advanced")
	}

	// steady must observe a contiguous sequence with no duplicates or gaps.
	for want := uint64(1); want <= 2; want++ {
		m, err := steady.Read()
		if err != nil {
			t.Fatalf("steady Read error: %v", err)
		}
		if m.Seq != want {
			t.Fatalf("steady got seq %d, want %d", m.Seq, want)
		}
	}
}

// TestConcurrentStress hammers the broadcast with many publishers and
// subscribers and verifies each subscriber receives exactly the contiguous
// sequence 0..total-1 with no duplicates or skips.
func TestConcurrentStress(t *testing.T) {
	const (
		publishers   = 4
		perPublisher = 250
		subscribers  = 3
		total        = publishers * perPublisher
	)
	b := New(8)

	subs := make([]*Subscriber, 0, subscribers)
	for i := 0; i < subscribers; i++ {
		subs = append(subs, b.Subscribe())
	}

	start := newBarrier(publishers + subscribers)
	var wg sync.WaitGroup

	for p := 0; p < publishers; p++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			start.wait()
			for i := 0; i < perPublisher; i++ {
				if _, err := b.Publish(i); err != nil {
					t.Errorf("Publish error: %v", err)
					return
				}
			}
		}()
	}

	readErrs := make(chan error, subscribers)
	for _, s := range subs {
		wg.Add(1)
		go func(s *Subscriber) {
			defer wg.Done()
			start.wait()
			for want := uint64(0); want < total; want++ {
				m, err := s.Read()
				if err != nil {
					readErrs <- err
					return
				}
				if m.Seq != want {
					t.Errorf("subscriber got seq %d, want %d", m.Seq, want)
					return
				}
			}
		}(s)
	}

	wg.Wait()
	close(readErrs)
	for err := range readErrs {
		t.Fatalf("Read error: %v", err)
	}
}

// TestUnsubscribeDuringStress removes subscribers mid-stream while publishers
// are blocked, ensuring cancellation never deadlocks publication.
func TestUnsubscribeDuringStress(t *testing.T) {
	b := New(2)
	const total = 100

	keep := b.Subscribe()
	dropping := make([]*Subscriber, 4)
	for i := range dropping {
		dropping[i] = b.Subscribe()
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < total; i++ {
			if _, err := b.Publish(i); err != nil {
				t.Errorf("Publish error: %v", err)
				return
			}
		}
	}()

	// Cancel the extra subscribers one by one while the publisher works.
	for _, s := range dropping {
		time.Sleep(time.Millisecond)
		s.Unsubscribe()
	}

	// The remaining subscriber drains everything and then sees ErrClosed.
	for want := uint64(0); want < total; want++ {
		m, err := keep.Read()
		if err != nil {
			t.Fatalf("Read error: %v", err)
		}
		if m.Seq != want {
			t.Fatalf("got seq %d, want %d", m.Seq, want)
		}
	}
	wg.Wait()
	b.Close()
	if _, err := keep.Read(); err != ErrClosed {
		t.Fatalf("final Read err = %v, want ErrClosed", err)
	}
}
