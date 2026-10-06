package execcache

import (
	"context"
	"sync"
)

// Result is the outcome of a successful execution.
type Result struct {
	Output []byte
}

// ExecFunc runs the task. The passed context is cancelled only when the
// last waiter on the execution goes away.
type ExecFunc func(ctx context.Context) (Result, error)

// Cache deduplicates and memoizes executions by request key.
//
// Concurrent calls with the same key share one in-flight execution.
// Successful results are memoized; failures are not. The upstream
// execution keeps running while at least one waiter remains and is
// cancelled once the last waiter leaves.
type Cache struct {
	mu       sync.Mutex
	entries  map[string]Result
	inflight map[string]*call
}

// New returns an empty Cache.
func New() *Cache {
	return &Cache{
		entries:  make(map[string]Result),
		inflight: make(map[string]*call),
	}
}

// call tracks one in-flight execution and its waiters.
type call struct {
	key     string
	done    chan struct{}
	res     Result
	err     error
	waiters int
	cancel  context.CancelFunc
}

// Do returns the result for req, executing exec at most once per key.
// A cached success is returned immediately. If ctx is cancelled while
// waiting, Do returns ctx.Err(); the shared execution is cancelled only
// when no waiters remain.
func (c *Cache) Do(ctx context.Context, req Request, exec ExecFunc) (Result, error) {
	key := Key(req)

	c.mu.Lock()
	if res, ok := c.entries[key]; ok {
		c.mu.Unlock()
		return res, nil
	}
	cl, ok := c.inflight[key]
	if !ok {
		execCtx, cancel := context.WithCancel(context.Background())
		cl = &call{key: key, done: make(chan struct{}), cancel: cancel}
		c.inflight[key] = cl
		go c.run(cl, execCtx, exec)
	}
	cl.waiters++
	c.mu.Unlock()

	select {
	case <-cl.done:
		return cl.res, cl.err
	case <-ctx.Done():
		c.leave(cl)
		return Result{}, ctx.Err()
	}
}

func (c *Cache) run(cl *call, ctx context.Context, exec ExecFunc) {
	res, err := exec(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil {
		c.entries[cl.key] = res
	}
	if cur, ok := c.inflight[cl.key]; ok && cur == cl {
		delete(c.inflight, cl.key)
	}
	cl.res, cl.err = res, err
	close(cl.done)
}

// leave detaches a waiter; when the last one leaves while the execution
// is still in flight, the upstream context is cancelled.
func (c *Cache) leave(cl *call) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cl.waiters--
	if cl.waiters > 0 {
		return
	}
	if cur, ok := c.inflight[cl.key]; ok && cur == cl {
		delete(c.inflight, cl.key)
		cl.cancel()
	}
}
