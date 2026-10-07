package forward

import (
	"sync"
	"sync/atomic"
)

// Chunk is a leased body block. Every destination of a fan-out holds its own
// lease on the same underlying block; the block is returned to its pool only
// after the publisher and every destination have released their leases, so a
// single unreleased lease prevents reuse.
type Chunk struct {
	// Data carries the block bytes. It must be treated as read-only.
	Data []byte

	id   uint64
	pool *Pool
	refs atomic.Int32
}

// ID uniquely identifies the underlying block within its pool, letting tests
// verify that a block is never recycled while a lease is outstanding.
func (c *Chunk) ID() uint64 { return c.id }

// Lease acquires an additional hold on the block. The caller must eventually
// call Release exactly once per Lease.
func (c *Chunk) Lease() *Chunk {
	c.refs.Add(1)
	return c
}

// Release drops one hold. When the last hold is dropped the block returns to
// its pool and becomes eligible for reuse.
func (c *Chunk) Release() {
	if c.refs.Add(-1) != 0 {
		return
	}
	c.pool.recycle(c)
}

// Pool hands out leased blocks and recycles them once fully released.
type Pool struct {
	mu     sync.Mutex
	idle   []*Chunk
	nextID uint64
	inUse  int
}

// NewPool returns an empty block pool.
func NewPool() *Pool { return &Pool{} }

// Get returns a block with room for size bytes and one outstanding lease
// owned by the caller.
func (p *Pool) Get(size int) *Chunk {
	p.mu.Lock()
	if n := len(p.idle); n > 0 {
		c := p.idle[n-1]
		p.idle = p.idle[:n-1]
		p.inUse++
		p.mu.Unlock()
		if cap(c.Data) < size {
			c.Data = make([]byte, size)
		} else {
			c.Data = c.Data[:size]
		}
		c.refs.Store(1)
		return c
	}
	p.nextID++
	id := p.nextID
	p.inUse++
	p.mu.Unlock()
	c := &Chunk{Data: make([]byte, size), id: id, pool: p}
	c.refs.Store(1)
	return c
}

func (p *Pool) recycle(c *Chunk) {
	p.mu.Lock()
	p.idle = append(p.idle, c)
	p.inUse--
	p.mu.Unlock()
}

// InUse reports how many blocks currently have at least one outstanding
// lease. It is intended for tests and diagnostics.
func (p *Pool) InUse() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inUse
}
