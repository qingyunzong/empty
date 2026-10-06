package cache

import "context"

// Loader fetches a page's value and reports its byte size.
type Loader[V any] func(ctx context.Context) (value V, size int64, err error)

// loadCall is one in-flight load shared by all waiters for the same key.
type loadCall[V any] struct {
	done    chan struct{} // closed when the result is ready
	value   V
	err     error
	waiters int // number of callers still waiting
	cancel  context.CancelFunc
	version uint64 // page version captured at load start
	reserve int64  // bytes reserved against the budget
}

// Load returns the cached page if present; otherwise it starts (or joins) a
// singleflight load for the key. Concurrent loads of the same key execute
// the loader exactly once and share the result.
//
// reserve bytes are charged against the shared budget for the duration of
// the load; if they do not fit, Load fails immediately with
// ErrBudgetExhausted and the loader never runs.
//
// Cancellation of one waiter only detaches that waiter; the load itself is
// cancelled only once every waiter has cancelled. When the load finishes,
// the result is published to the cache only if the page version has not
// changed since the load started (i.e. no Invalidate or Insert happened in
// between) and it fits within the budget; waiters receive the loaded value
// regardless of whether it was publishable.
func (c *Cache[K, V]) Load(ctx context.Context, key K, reserve int64, loader Loader[V]) (V, error) {
	var zero V
	if reserve < 0 {
		return zero, ErrInvalidSize
	}
	c.mu.Lock()
	if p, ok := c.pages[key]; ok {
		c.seq++
		p.seq = c.seq
		value := p.value
		c.mu.Unlock()
		return value, nil
	}
	if lc, ok := c.loads[key]; ok {
		lc.waiters++
		c.mu.Unlock()
		return c.waitLoad(ctx, lc)
	}
	if c.used+c.reserved+reserve > c.budget {
		c.mu.Unlock()
		return zero, ErrBudgetExhausted
	}
	lctx, cancel := context.WithCancel(context.Background())
	lc := &loadCall[V]{
		done:    make(chan struct{}),
		waiters: 1,
		cancel:  cancel,
		version: c.versions[key],
		reserve: reserve,
	}
	c.loads[key] = lc
	c.reserved += reserve
	c.mu.Unlock()
	go c.runLoad(key, lc, lctx, loader)
	return c.waitLoad(ctx, lc)
}

// waitLoad blocks until the shared load finishes or the caller's context is
// cancelled. On cancellation the waiter detaches; the load is cancelled once
// its last waiter detaches.
func (c *Cache[K, V]) waitLoad(ctx context.Context, lc *loadCall[V]) (V, error) {
	select {
	case <-lc.done:
		return lc.value, lc.err
	case <-ctx.Done():
		c.mu.Lock()
		lc.waiters--
		if lc.waiters == 0 {
			lc.cancel()
		}
		c.mu.Unlock()
		var zero V
		return zero, ctx.Err()
	}
}

// runLoad executes the loader and publishes the result if it is still fresh.
func (c *Cache[K, V]) runLoad(key K, lc *loadCall[V], ctx context.Context, loader Loader[V]) {
	value, size, err := loader(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reserved -= lc.reserve
	delete(c.loads, key)
	if err == nil {
		if size <= 0 {
			err = ErrInvalidSize
		} else if c.versions[key] == lc.version {
			// Version unchanged: publish. If it does not fit (e.g. the
			// budget is pinned by leases), the value is simply not cached;
			// waiters still receive it.
			_ = c.insertLocked(key, value, size)
		}
	}
	lc.value, lc.err = value, err
	close(lc.done)
}
