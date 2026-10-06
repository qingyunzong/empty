package faultinj

import "sync"

// Barrier is a reusable synchronization point for a fixed number of
// parties. Tests use it to force deterministic interleavings when
// verifying scope nesting and concurrency isolation.
type Barrier struct {
	mu      sync.Mutex
	cond    *sync.Cond
	parties int
	count   int
	gen     uint64
}

// NewBarrier returns a Barrier for the given number of parties.
func NewBarrier(parties int) *Barrier {
	if parties < 1 {
		panic("faultinj: barrier requires at least one party")
	}
	b := &Barrier{parties: parties}
	b.cond = sync.NewCond(&b.mu)
	return b
}

// Await blocks until all parties have arrived, then releases everyone.
// The barrier resets itself and can be reused for further phases.
func (b *Barrier) Await() {
	b.mu.Lock()
	gen := b.gen
	b.count++
	if b.count == b.parties {
		b.count = 0
		b.gen++
		b.cond.Broadcast()
		b.mu.Unlock()
		return
	}
	for gen == b.gen {
		b.cond.Wait()
	}
	b.mu.Unlock()
}

// Parties returns the number of parties the barrier synchronizes.
func (b *Barrier) Parties() int { return b.parties }
