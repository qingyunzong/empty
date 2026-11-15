package dataeng

import (
	"context"
	"os"
	"sync"
)

type preparedShard struct {
	shard Shard
	file  *os.File
	size  int64
}

func (p *preparedShard) close() {
	if p == nil || p.file == nil {
		return
	}
	name := p.file.Name()
	_ = p.file.Close()
	_ = os.Remove(name)
	p.file = nil
}

type prepareResult struct {
	prepared *preparedShard
	err      error
}

type prefetchSlot struct {
	ready chan struct{}
	res   prepareResult
}

// prefetcher downloads and verifies a bounded window of shards concurrently.
// The reader consumes verified shards strictly in order.
type prefetcher struct {
	ctx    context.Context
	cancel context.CancelFunc

	consumer    *Consumer
	shards      []Shard
	concurrency int
	window      int

	mu        sync.Mutex
	cond      *sync.Cond
	slots     []*prefetchSlot
	nextStart int
	demand    int
	active    int
	closed    bool

	wg           sync.WaitGroup
	dispatchDone chan struct{}
}

func newPrefetcher(ctx context.Context, cancel context.CancelFunc, c *Consumer, shards []Shard) *prefetcher {
	p := &prefetcher{
		ctx:          ctx,
		cancel:       cancel,
		consumer:     c,
		shards:       shards,
		concurrency:  c.Concurrency,
		window:       c.Prefetch,
		slots:        make([]*prefetchSlot, len(shards)),
		dispatchDone: make(chan struct{}),
	}
	p.cond = sync.NewCond(&p.mu)
	for i := range p.slots {
		p.slots[i] = &prefetchSlot{ready: make(chan struct{})}
	}
	if len(p.slots) == 0 {
		close(p.dispatchDone)
		return p
	}
	go p.dispatch()
	return p
}

func (p *prefetcher) dispatch() {
	defer close(p.dispatchDone)
	p.mu.Lock()
	defer p.mu.Unlock()

	for {
		if p.closed {
			return
		}
		started := false
		for p.nextStart < len(p.slots) &&
			p.nextStart < p.demand+p.window &&
			p.active < p.concurrency {
			idx := p.nextStart
			p.nextStart++
			p.active++
			p.wg.Add(1)
			go p.prepare(idx)
			started = true
		}
		if !started {
			p.cond.Wait()
		}
	}
}

func (p *prefetcher) prepare(idx int) {
	shard := p.shards[idx]
	prepared, err := p.consumer.prepareShard(p.ctx, shard)

	p.mu.Lock()
	p.active--
	slot := p.slots[idx]
	slot.res = prepareResult{prepared: prepared, err: err}
	close(slot.ready)
	p.cond.Broadcast()
	p.mu.Unlock()

	p.wg.Done()
}

// request asks for the shard at idx and waits until it has been prepared.
func (p *prefetcher) request(idx int) (prepareResult, error) {
	p.mu.Lock()
	if idx > p.demand {
		p.demand = idx
	}
	slot := p.slots[idx]
	p.cond.Broadcast()
	p.mu.Unlock()

	select {
	case <-slot.ready:
		p.mu.Lock()
		res := slot.res
		slot.res.prepared = nil
		p.mu.Unlock()
		return res, nil
	case <-p.ctx.Done():
		select {
		case <-slot.ready:
			p.mu.Lock()
			res := slot.res
			slot.res.prepared = nil
			p.mu.Unlock()
			return res, nil
		default:
		}
		return prepareResult{}, p.ctx.Err()
	}
}

// release advances the prefetch window past idx.
func (p *prefetcher) release(idx int) {
	p.mu.Lock()
	if idx+1 > p.demand {
		p.demand = idx + 1
	}
	p.cond.Broadcast()
	p.mu.Unlock()
}

// Close cancels outstanding downloads and removes all staged shard files.
func (p *prefetcher) Close() {
	p.mu.Lock()
	alreadyClosed := p.closed
	p.closed = true
	p.cancel()
	p.cond.Broadcast()
	p.mu.Unlock()

	if !alreadyClosed {
		<-p.dispatchDone
	}
	p.wg.Wait()

	p.mu.Lock()
	for _, slot := range p.slots {
		slot.res.prepared.close()
		slot.res.prepared = nil
	}
	p.mu.Unlock()
}
