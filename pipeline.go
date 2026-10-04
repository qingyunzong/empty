// Package threepipe provides a multi-stage processing pipeline that emits
// results in input order while allowing stages to complete out of order.
//
// Semantics:
//   - Items are submitted with Submit and flow through the stages in order;
//     each stage runs with several workers, so items may finish a stage out
//     of order, but results are always emitted in submission order.
//   - Pause blocks only new submissions; already accepted items keep
//     draining through the stages. Resume unblocks submitters.
//   - The total number of in-flight items (accepted but not yet emitted)
//     never exceeds the limit given to New, even when the output channel is
//     not being drained.
//   - The first failing item cancels all subsequent items: results for items
//     before it are still emitted (the already-produced prefix is
//     preserved), then the error is emitted and the output channel is
//     closed. Later submissions fail with ErrFailed.
package threepipe

import (
	"context"
	"errors"
	"math"
	"sync"
	"sync/atomic"
)

// ErrClosed is returned by Submit after Close was called.
var ErrClosed = errors.New("threepipe: pipeline closed")

// ErrFailed is returned by Submit after an item has failed.
var ErrFailed = errors.New("threepipe: pipeline failed")

// Stage transforms one item. Returning an error fails the item, which
// cancels all subsequent items in the pipeline.
type Stage[T any] func(ctx context.Context, v T) (T, error)

// Result is one emitted output. Err is non-nil only for the failing item,
// which is always the last result emitted.
type Result[T any] struct {
	Seq   int64
	Value T
	Err   error
}

type task[T any] struct {
	seq int64
	val T
}

// Pipeline is a bounded, order-preserving multi-stage processor.
type Pipeline[T any] struct {
	stages  []Stage[T]
	workers int

	sem chan struct{} // in-flight limit; one token per accepted item

	mu       sync.Mutex
	cond     sync.Cond // signalled when active drops to zero
	paused   bool
	closed   bool
	active   int           // accepted items not yet released
	resumeCh chan struct{} // closed to wake paused submitters

	nextSeq   atomic.Int64
	failedSeq atomic.Int64 // math.MaxInt64 while no failure

	in      chan task[T]
	results chan Result[T]
	out     chan Result[T]

	ctx    context.Context
	cancel context.CancelFunc
}

// New builds a pipeline with the given stages. maxInFlight bounds the number
// of accepted-but-not-yet-emitted items; workers sets the concurrency of
// each stage. Both must be positive.
func New[T any](maxInFlight, workers int, stages ...Stage[T]) *Pipeline[T] {
	if maxInFlight <= 0 {
		panic("threepipe: maxInFlight must be positive")
	}
	if workers <= 0 {
		panic("threepipe: workers must be positive")
	}
	if len(stages) == 0 {
		panic("threepipe: at least one stage is required")
	}
	ctx, cancel := context.WithCancel(context.Background())
	resumed := make(chan struct{})
	close(resumed) // invariant: resumeCh is closed iff not paused
	p := &Pipeline[T]{
		stages:   stages,
		workers:  workers,
		sem:      make(chan struct{}, maxInFlight),
		resumeCh: resumed,
		in:       make(chan task[T]),
		results:  make(chan Result[T]),
		out:      make(chan Result[T]),
		ctx:      ctx,
		cancel:   cancel,
	}
	p.cond.L = &p.mu
	p.failedSeq.Store(math.MaxInt64)

	// Chain of channels between stages; the last stage feeds p.results.
	chains := make([]chan task[T], len(stages))
	chains[0] = p.in
	for i := 1; i < len(stages); i++ {
		chains[i] = make(chan task[T])
	}
	for i := range stages {
		in, out := chains[i], chan task[T](nil)
		if i+1 < len(stages) {
			out = chains[i+1]
		}
		var swg sync.WaitGroup
		for w := 0; w < workers; w++ {
			swg.Add(1)
			go func(idx int, in <-chan task[T], out chan<- task[T]) {
				defer swg.Done()
				p.runStage(idx, in, out)
			}(i, in, out)
		}
		go func(out chan<- task[T]) {
			swg.Wait()
			if out != nil {
				close(out)
			} else {
				close(p.results)
			}
		}(out)
	}
	go p.reorder()
	return p
}

// Submit accepts v into the pipeline, blocking while paused or while the
// in-flight limit is reached. It returns ErrClosed after Close and
// ErrFailed after any item has failed.
func (p *Pipeline[T]) Submit(ctx context.Context, v T) error {
	p.mu.Lock()
	for p.paused && !p.closed && p.failedSeq.Load() == math.MaxInt64 {
		ch := p.resumeCh
		p.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
		p.mu.Lock()
	}
	if p.closed {
		p.mu.Unlock()
		return ErrClosed
	}
	if p.failedSeq.Load() != math.MaxInt64 {
		p.mu.Unlock()
		return ErrFailed
	}
	p.mu.Unlock()

	select {
	case p.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	seq := p.nextSeq.Add(1) - 1
	p.mu.Lock()
	p.active++
	p.mu.Unlock()

	// Workers always drain p.in until Close, so this send cannot block
	// forever; no need to select on ctx here.
	p.in <- task[T]{seq: seq, val: v}
	return nil
}

// Pause blocks subsequent Submit calls until Resume. Already accepted items
// keep draining through the stages.
func (p *Pipeline[T]) Pause() {
	p.mu.Lock()
	if !p.paused {
		p.paused = true
		p.resumeCh = make(chan struct{})
	}
	p.mu.Unlock()
}

// Resume unblocks submitters paused by Pause.
func (p *Pipeline[T]) Resume() {
	p.mu.Lock()
	p.wakeLocked()
	p.mu.Unlock()
}

// wakeLocked unblocks paused submitters. Callers must hold p.mu.
func (p *Pipeline[T]) wakeLocked() {
	if p.paused {
		p.paused = false
		close(p.resumeCh)
	}
}

// Close stops accepting submissions, waits for all accepted items to drain,
// and closes the output channel once every result has been emitted.
func (p *Pipeline[T]) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.wakeLocked()
	for p.active != 0 {
		p.cond.Wait()
	}
	p.mu.Unlock()

	close(p.in)
}

// Outputs returns the channel of ordered results. It is closed after the
// final result (the last accepted item, or the first failure) is emitted.
func (p *Pipeline[T]) Outputs() <-chan Result[T] {
	return p.out
}

// runStage processes tasks for one stage until its input channel closes.
func (p *Pipeline[T]) runStage(idx int, in <-chan task[T], out chan<- task[T]) {
	last := idx == len(p.stages)-1
	for t := range in {
		if p.dropped(t.seq) {
			p.release()
			continue
		}
		v, err := p.stages[idx](p.ctx, t.val)
		if err != nil {
			if p.recordFailure(t.seq) {
				// Token released by the reorder loop after emitting.
				p.results <- Result[T]{Seq: t.seq, Err: err}
			} else {
				p.release()
			}
			continue
		}
		if last {
			p.results <- Result[T]{Seq: t.seq, Value: v}
			continue
		}
		out <- task[T]{seq: t.seq, val: v}
	}
}

// reorder emits results in submission order. On failure it emits the error
// for the failing sequence, then releases every remaining in-flight item
// and closes the output.
func (p *Pipeline[T]) reorder() {
	pending := make(map[int64]Result[T])
	var next int64
	for res := range p.results {
		pending[res.Seq] = res
		for {
			r, ok := pending[next]
			if !ok {
				break
			}
			delete(pending, next)
			p.out <- r
			p.release()
			next++
			if r.Err != nil {
				for range pending {
					p.release()
				}
				// Close the output promptly so readers observe the
				// failure, then keep draining stragglers in the
				// background so their tokens are released and Close
				// can observe a fully drained pipeline.
				close(p.out)
				p.cancel()
				for range p.results {
					p.release()
				}
				return
			}
		}
	}
	close(p.out)
	p.cancel()
}

// dropped reports whether seq falls after a recorded failure and must be
// discarded without processing.
func (p *Pipeline[T]) dropped(seq int64) bool {
	return seq > p.failedSeq.Load()
}

// recordFailure records seq as the first failing sequence. Only the caller
// that wins the minimum gets true; its result is emitted by the reorder
// loop, all others are released by their callers.
func (p *Pipeline[T]) recordFailure(seq int64) bool {
	for {
		cur := p.failedSeq.Load()
		if cur <= seq {
			return false
		}
		if p.failedSeq.CompareAndSwap(cur, seq) {
			p.mu.Lock()
			p.wakeLocked()
			p.mu.Unlock()
			return true
		}
	}
}

// release returns one in-flight token and wakes Close when the pipeline
// has fully drained.
func (p *Pipeline[T]) release() {
	<-p.sem
	p.mu.Lock()
	p.active--
	if p.active == 0 {
		p.cond.Broadcast()
	}
	p.mu.Unlock()
}
