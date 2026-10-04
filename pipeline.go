// Package pipeline provides a concurrent multi-stage processing pipeline.
//
// Items flow through a fixed sequence of stages. Each stage runs several
// workers, so items may complete a stage out of order, but the pipeline
// always emits results in input order. The number of in-flight items
// (accepted but not yet emitted) never exceeds a configured bound, even
// when the output channel is blocked. Pause stops accepting new input
// while already-accepted items keep draining to the output. A stage
// failure cancels all subsequent items and preserves the already-emitted
// prefix; Run returns the first failure (by input position).
package pipeline

import (
	"context"
	"errors"
	"sync"
)

// Stage transforms one item. The ctx is cancelled when the item has been
// cancelled because an earlier item failed or the run context was
// cancelled. A Stage must be safe for concurrent use by multiple workers.
type Stage func(ctx context.Context, v any) (any, error)

// ErrClosed is returned by Pause and Resume when the pipeline is not
// running anymore.
var ErrClosed = errors.New("pipeline: not running")

type item struct {
	seq    int
	val    any
	err    error
	ctx    context.Context
	cancel context.CancelFunc
}

// Pipeline is a single-use processing pipeline. Create one with New and
// start it with Run.
type Pipeline struct {
	stages      []Stage
	workers     int
	maxInFlight int

	// Pause/Resume handshake with the acceptor goroutine. Both channels
	// are unbuffered: a successful send means the acceptor has
	// acknowledged the state change.
	pauseCh  chan struct{}
	resumeCh chan struct{}

	// Mutable run state, initialised by Run.
	runCtx context.Context
	done   chan struct{}
	doneMu sync.Once
	sem    chan struct{}

	mu       sync.Mutex // guards failed, failSeq, firstErr and reg
	failed   bool
	failSeq  int
	firstErr error
	reg      map[int]context.CancelFunc
}

// New builds a pipeline that runs every item through stages in order.
// workers is the number of concurrent workers per stage (must be >= 1);
// items may finish a stage out of order but are emitted in input order.
// maxInFlight bounds the number of accepted-but-not-yet-emitted items
// (must be >= 1) and applies even while the output channel is blocked.
func New(workers, maxInFlight int, stages ...Stage) (*Pipeline, error) {
	if len(stages) == 0 {
		return nil, errors.New("pipeline: at least one stage is required")
	}
	if workers < 1 {
		return nil, errors.New("pipeline: workers must be >= 1")
	}
	if maxInFlight < 1 {
		return nil, errors.New("pipeline: maxInFlight must be >= 1")
	}
	return &Pipeline{
		stages:      stages,
		workers:     workers,
		maxInFlight: maxInFlight,
		pauseCh:     make(chan struct{}),
		resumeCh:    make(chan struct{}),
	}, nil
}

// Run consumes items from in, processes them through the stages and
// writes results to out in input order. It returns nil once in is closed
// and every accepted item has been emitted. If a stage fails, subsequent
// items are cancelled, the already-emitted prefix is preserved, and Run
// returns the error of the earliest failing item. Run returns early if
// ctx is cancelled.
//
// Run must be called at most once. Pause and Resume may be called from
// another goroutine while Run is active.
func (p *Pipeline) Run(ctx context.Context, in <-chan any, out chan<- any) error {
	p.runCtx = ctx
	p.done = make(chan struct{})
	p.sem = make(chan struct{}, p.maxInFlight)
	p.reg = make(map[int]context.CancelFunc)

	// Propagate run-context cancellation to the done signal.
	stopWatcher := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			p.closeDone()
		case <-stopWatcher:
		}
	}()
	defer close(stopWatcher)

	// Internal channels are buffered with maxInFlight so that workers
	// never block on forwarding: the semaphore guarantees that at most
	// maxInFlight items exist inside the pipeline at any time.
	channels := make([]chan *item, len(p.stages)+1)
	for i := range channels {
		channels[i] = make(chan *item, p.maxInFlight)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		p.accept(in, channels[0])
	}()
	for i, stage := range p.stages {
		wg.Add(1)
		go func(stage Stage, inCh, outCh chan *item) {
			defer wg.Done()
			p.runStage(stage, inCh, outCh)
		}(stage, channels[i], channels[i+1])
	}

	err := p.emit(channels[len(p.stages)], out)

	p.closeDone()
	wg.Wait()

	p.mu.Lock()
	for seq, cancel := range p.reg {
		cancel()
		delete(p.reg, seq)
	}
	p.mu.Unlock()
	return err
}

// Pause stops the acceptor from receiving new input. Items already
// accepted keep flowing and are emitted normally. Pause blocks until the
// acceptor has acknowledged the pause; after Pause returns, no further
// item is received from the input channel until Resume is called.
func (p *Pipeline) Pause() error {
	select {
	case p.pauseCh <- struct{}{}:
		return nil
	case <-p.done:
		return ErrClosed
	}
}

// Resume lets the acceptor receive new input again after a Pause. It
// blocks until the acceptor has acknowledged the resume.
func (p *Pipeline) Resume() error {
	select {
	case p.resumeCh <- struct{}{}:
		return nil
	case <-p.done:
		return ErrClosed
	}
}

func (p *Pipeline) closeDone() {
	p.doneMu.Do(func() { close(p.done) })
}

// accept receives items from in, assigns sequence numbers and forwards
// them to the first stage. It takes a semaphore slot before every
// receive, so the number of accepted-but-not-yet-emitted items never
// exceeds maxInFlight, even when the output is blocked.
func (p *Pipeline) accept(in <-chan any, first chan<- *item) {
	defer close(first)
	seq := 0
	for {
		select {
		case p.sem <- struct{}{}:
		case <-p.pauseCh:
			p.waitResume()
			continue
		case <-p.done:
			return
		}
		select {
		case v, ok := <-in:
			if !ok {
				<-p.sem
				return
			}
			it := &item{seq: seq, val: v}
			it.ctx, it.cancel = context.WithCancel(p.runCtx)
			p.register(it)
			seq++
			first <- it // buffered with maxInFlight: never blocks
		case <-p.pauseCh:
			<-p.sem // release the reserved slot while paused
			p.waitResume()
		case <-p.done:
			<-p.sem
			return
		}
	}
}

func (p *Pipeline) waitResume() {
	select {
	case <-p.resumeCh:
	case <-p.done:
	}
}

// runStage runs a worker pool for one stage and closes out when all
// workers are done.
func (p *Pipeline) runStage(stage Stage, in <-chan *item, out chan<- *item) {
	var wg sync.WaitGroup
	for w := 0; w < p.workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for it := range in {
				if it.err == nil {
					p.process(stage, it)
				}
				out <- it // buffered with maxInFlight: never blocks
			}
		}()
	}
	wg.Wait()
	close(out)
}

func (p *Pipeline) process(stage Stage, it *item) {
	if it.ctx.Err() != nil {
		// Cancelled because a preceding item failed or the run
		// context was cancelled; skip the stage function.
		it.err = it.ctx.Err()
		return
	}
	v, err := stage(it.ctx, it.val)
	if err != nil {
		it.err = err
		if it.ctx.Err() == nil {
			// Genuine stage failure (not a cancellation).
			p.recordFail(it.seq, err)
		}
		return
	}
	it.val = v
}

// emit reorders completed items and writes them to out in input order.
// On failure it emits every item preceding the earliest failed one and
// then returns the recorded error.
func (p *Pipeline) emit(results <-chan *item, out chan<- any) error {
	pending := make(map[int]*item)
	next := 0
	open := true
	for {
		p.mu.Lock()
		failed, failSeq, firstErr := p.failed, p.failSeq, p.firstErr
		p.mu.Unlock()
		if failed && next >= failSeq {
			return firstErr
		}
		if it, ok := pending[next]; ok {
			delete(pending, next)
			if it.err != nil {
				// A failure that was not recorded by a worker
				// (e.g. run-context cancellation).
				p.recordFail(it.seq, it.err)
				continue
			}
			select {
			case out <- it.val:
			case <-p.done:
				if !p.isFailed() {
					return p.runCtx.Err()
				}
				out <- it.val // preserve the prefix even under cancellation
			}
			p.unregister(it.seq)
			<-p.sem // release the in-flight slot
			next++
			continue
		}
		if !open {
			return nil
		}
		it, ok := <-results
		if !ok {
			open = false
			continue
		}
		pending[it.seq] = it
	}
}

func (p *Pipeline) isFailed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.failed
}

// recordFail records err as the pipeline failure, keeping the error of
// the earliest failing item, cancels every registered item after it and
// stops the acceptor.
func (p *Pipeline) recordFail(seq int, err error) {
	p.mu.Lock()
	if !p.failed || seq < p.failSeq {
		p.failed = true
		p.failSeq = seq
		p.firstErr = err
	}
	failSeq := p.failSeq
	var cancels []context.CancelFunc
	for s, cancel := range p.reg {
		if s > failSeq {
			cancels = append(cancels, cancel)
			delete(p.reg, s)
		}
	}
	p.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	p.closeDone()
}

// register stores the cancel function of a newly accepted item. If the
// item already follows a recorded failure it is cancelled immediately.
func (p *Pipeline) register(it *item) {
	p.mu.Lock()
	if p.failed && it.seq > p.failSeq {
		p.mu.Unlock()
		it.cancel()
		return
	}
	p.reg[it.seq] = it.cancel
	p.mu.Unlock()
}

func (p *Pipeline) unregister(seq int) {
	p.mu.Lock()
	delete(p.reg, seq)
	p.mu.Unlock()
}
