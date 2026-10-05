package logcompact

import "sync"

// barrier is a reusable cyclic barrier for n parties. await blocks until
// all n parties arrive, then releases them together. The mutex provides
// the happens-before edges that let a controller publish a round plan
// before a barrier and read results after the next one.
type barrier struct {
	n     int
	count int
	gen   uint64
	mu    sync.Mutex
	cond  *sync.Cond
}

func newBarrier(n int) *barrier {
	b := &barrier{n: n}
	b.cond = sync.NewCond(&b.mu)
	return b
}

func (b *barrier) await() {
	b.mu.Lock()
	gen := b.gen
	b.count++
	if b.count == b.n {
		b.count = 0
		b.gen++
		b.cond.Broadcast()
	} else {
		for gen == b.gen {
			b.cond.Wait()
		}
	}
	b.mu.Unlock()
}
