package forward

import "sync/atomic"

// Chunk is one leased buffer read from upstream. Every destination of a
// Forward call shares the same original chunk: the forwarder holds one
// lease and takes one more per destination via Retain. The backing buffer
// returns to its pool only when the last Release drops the count to zero,
// so any unreleased lease prevents reuse.
type Chunk struct {
	// Data is the valid payload; it aliases the leased backing buffer.
	Data []byte

	buf  []byte
	pool *Pool
	refs atomic.Int32
}

func newChunk(p *Pool) *Chunk {
	buf := p.get()
	c := &Chunk{buf: buf, pool: p, Data: buf[:0]}
	c.refs.Store(1)
	return c
}

// Retain takes one additional lease on the chunk.
func (c *Chunk) Retain() { c.refs.Add(1) }

// Release drops one lease; the backing buffer is recycled on the last one.
func (c *Chunk) Release() {
	if c.refs.Add(-1) == 0 {
		c.pool.put(c.buf)
	}
}

// Leases reports the number of outstanding leases.
func (c *Chunk) Leases() int32 { return c.refs.Load() }
