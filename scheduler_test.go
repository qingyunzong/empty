package dataeng

import (
	"context"
	"sync"
	"testing"
	"time"
)

const testTimeout = 5 * time.Second

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", msg)
}

func assertNot(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(50 * time.Millisecond)
	for time.Now().Before(deadline) {
		if cond() {
			t.Fatalf("unexpected condition became true: %s", msg)
		}
		time.Sleep(time.Millisecond)
	}
}

// cbCtl is a controllable callback: tasks block until their release channel is
// closed, and start/cancel events are recorded for assertions.
type cbCtl struct {
	mu       sync.Mutex
	started  map[int64]chan struct{}
	order    []int64
	releases map[int64]chan struct{}
	canceled map[int64]bool
}

func newCbCtl() *cbCtl {
	return &cbCtl{
		started:  map[int64]chan struct{}{},
		canceled: map[int64]bool{},
		releases: map[int64]chan struct{}{},
	}
}

func (c *cbCtl) register(seq int64) chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	rel := make(chan struct{})
	c.releases[seq] = rel
	return rel
}

// registerDone makes the callback for seq return immediately.
func (c *cbCtl) registerDone(seq int64) {
	close(c.register(seq))
}

func (c *cbCtl) release(seq int64) {
	c.mu.Lock()
	rel, ok := c.releases[seq]
	c.mu.Unlock()
	if ok {
		close(rel)
	}
}

func (c *cbCtl) waitStart(seq int64) chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ch, ok := c.started[seq]; ok {
		return ch
	}
	ch := make(chan struct{})
	c.started[seq] = ch
	return ch
}

func (c *cbCtl) waitCancel(seq int64) chan struct{} {
	ch := make(chan struct{})
	go func() {
		defer close(ch)
		deadline := time.Now().Add(testTimeout)
		for time.Now().Before(deadline) {
			c.mu.Lock()
			done := c.canceled[seq]
			c.mu.Unlock()
			if done {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	return ch
}

func (c *cbCtl) startedCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.started)
}

func (c *cbCtl) startOrder() []int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]int64, len(c.order))
	copy(out, c.order)
	return out
}

func (c *cbCtl) isCanceled(seq int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.canceled[seq]
}

func (c *cbCtl) callback(ctx context.Context, task Task) {
	c.mu.Lock()
	if ch, ok := c.started[task.Seq]; ok {
		close(ch)
	} else {
		ch := make(chan struct{})
		close(ch)
		c.started[task.Seq] = ch
	}
	c.order = append(c.order, task.Seq)
	rel := c.releases[task.Seq]
	c.mu.Unlock()

	if rel != nil {
		select {
		case <-rel:
		case <-ctx.Done():
			c.mu.Lock()
			c.canceled[task.Seq] = true
			c.mu.Unlock()
			<-rel
		}
	}
	if ctx.Err() != nil {
		c.mu.Lock()
		c.canceled[task.Seq] = true
		c.mu.Unlock()
	}
}

func baseConfig() Config {
	return Config{
		MaxConcurrent: 4,
		SourceLimits: map[string]SourceConfig{
			"A": {MaxConcurrent: 2, MinStartInterval: time.Second},
			"B": {MaxConcurrent: 2, MinStartInterval: time.Second},
		},
	}
}

func newTestScheduler(t *testing.T, cfg Config, cb Callback) (*Scheduler, *FakeClock) {
	t.Helper()
	clk := NewFakeClock(time.Unix(1000, 0))
	s, err := New(cfg, clk, cb)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(s.Close)
	return s, clk
}

func mustSubmit(t *testing.T, s *Scheduler, task Task) *Handle {
	t.Helper()
	h, err := s.Submit(task)
	if err != nil {
		t.Fatalf("Submit %d: %v", task.Seq, err)
	}
	return h
}
