package forward

import (
	"sync"
	"sync/atomic"
)

// Pool recycles chunk buffers. A buffer is handed out again only after
// every lease on it has been released; any outstanding lease blocks reuse.
type Pool struct {
	bufSize int
	maxIdle int

	mu   sync.Mutex
	idle [][]byte

	outstanding atomic.Int64
}

// NewPool returns a pool of bufSize-byte buffers keeping at most maxIdle
// idle buffers (maxIdle <= 0 selects a small default).
func NewPool(bufSize, maxIdle int) *Pool {
	if maxIdle <= 0 {
		maxIdle = 32
	}
	return &Pool{bufSize: bufSize, maxIdle: maxIdle}
}

func (p *Pool) get() []byte {
	p.outstanding.Add(1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if n := len(p.idle); n > 0 {
		buf := p.idle[n-1]
		p.idle[n-1] = nil
		p.idle = p.idle[:n-1]
		return buf
	}
	return make([]byte, p.bufSize)
}

func (p *Pool) put(buf []byte) {
	p.outstanding.Add(-1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.idle) < p.maxIdle {
		p.idle = append(p.idle, buf)
	}
}

// Idle reports how many buffers currently sit on the free list.
func (p *Pool) Idle() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.idle)
}

// Outstanding reports gets minus puts: zero means no leased buffer leaks.
func (p *Pool) Outstanding() int64 { return p.outstanding.Load() }
