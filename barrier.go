package aggregator

import (
	"context"
	"fmt"
	"sort"
	"sync"
)

// Barrier is a Sender test double that records every sealed batch it
// receives and blocks each send until the test completes it. Tests use
// it to verify how items were partitioned into batches and which
// sequence ranges were acknowledged.
type Barrier struct {
	mu      sync.Mutex
	sent    []Batch
	pending map[int]chan error // seq -> completion channel of an in-flight send
	acked   map[int]error      // seq -> error the send was completed with
	ackSeqs []int              // acked sequences in completion order
	changed chan struct{}      // closed and replaced on every state change
}

// NewBarrier returns a ready-to-use Barrier.
func NewBarrier() *Barrier {
	return &Barrier{
		pending: make(map[int]chan error),
		acked:   make(map[int]error),
		changed: make(chan struct{}),
	}
}

// Send implements Sender. It records the batch and blocks until the
// test completes the batch's sequence with Complete, or ctx is done.
func (b *Barrier) Send(ctx context.Context, batch Batch) error {
	done := make(chan error, 1)
	b.mu.Lock()
	b.sent = append(b.sent, batch)
	b.pending[batch.Seq] = done
	close(b.changed)
	b.changed = make(chan struct{})
	b.mu.Unlock()

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Complete finishes the in-flight send of seq with err. It panics if no
// send for seq is in flight.
func (b *Barrier) Complete(seq int, err error) {
	b.mu.Lock()
	done, ok := b.pending[seq]
	if !ok {
		b.mu.Unlock()
		panic(fmt.Sprintf("aggregator: barrier complete of unknown seq %d", seq))
	}
	delete(b.pending, seq)
	b.acked[seq] = err
	b.ackSeqs = append(b.ackSeqs, seq)
	close(b.changed)
	b.changed = make(chan struct{})
	b.mu.Unlock()
	done <- err
}

// WaitSent blocks until at least n batches have been sent.
func (b *Barrier) WaitSent(ctx context.Context, n int) error {
	b.mu.Lock()
	for len(b.sent) < n {
		ch := b.changed
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		}
		b.mu.Lock()
	}
	b.mu.Unlock()
	return nil
}

// Batches returns a copy of the batches sent so far, ordered by
// sequence number.
func (b *Barrier) Batches() []Batch {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Batch, len(b.sent))
	copy(out, b.sent)
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// Acked returns the acknowledged sequences in completion order.
func (b *Barrier) Acked() []int {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]int, len(b.ackSeqs))
	copy(out, b.ackSeqs)
	return out
}

// AckedRange reports the contiguous acknowledged range [lo, hi) of
// sequence numbers starting at lo. An empty range is (0, 0).
func (b *Barrier) AckedRange(lo int) (int, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	hi := lo
	for {
		if _, ok := b.acked[hi]; !ok {
			return lo, hi
		}
		hi++
	}
}
