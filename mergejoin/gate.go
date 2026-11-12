package mergejoin

import "sync"

// Gate coordinates consumer pause/resume flow control. It is safe for
// concurrent use: the Joiner blocks on Wait while another goroutine calls
// Resume. A Gate may be reused across many pause cycles.
type Gate struct {
	mu     sync.Mutex
	paused bool
	open   chan struct{}
}

// NewGate creates an open gate.
func NewGate() *Gate {
	return &Gate{open: make(chan struct{})}
}

// Pause asks the Joiner to block after the current pair is acknowledged.
// Pausing while already paused is a no-op.
func (g *Gate) Pause() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.paused {
		return
	}
	g.paused = true
	g.open = make(chan struct{})
}

// Resume unblocks a paused Joiner. Resuming while running only clears any
// pending pause request, so the next Wait returns immediately.
func (g *Gate) Resume() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.paused {
		return
	}
	g.paused = false
	close(g.open)
}

// Wait blocks until Resume if Pause was requested, otherwise returns at
// once. When a non-nil cancel channel fires, the wait is released as well so
// a canceled run cannot deadlock against a paused consumer.
func (g *Gate) Wait(cancel <-chan struct{}) {
	g.mu.Lock()
	if !g.paused {
		g.mu.Unlock()
		return
	}
	open := g.open
	g.mu.Unlock()

	if cancel == nil {
		<-open
		return
	}
	select {
	case <-open:
	case <-cancel:
	}
}
