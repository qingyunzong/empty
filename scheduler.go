package dataeng

import (
	"container/heap"
	"context"
	"errors"
	"sync"
	"time"
)

// ErrClosed is returned when submitting or cancelling on a closed scheduler.
var ErrClosed = errors.New("dataeng: scheduler is closed")

// ErrDuplicateSeq is returned when a task reuses a sequence already known to
// the scheduler (either pending or running).
var ErrDuplicateSeq = errors.New("dataeng: duplicate task sequence")

// Task is a unit of work belonging to a source.
//
// Seq is the caller-assigned, strictly increasing submission sequence and is
// unique within the scheduler. It is only used as a tie-breaker among tasks
// with the same ready time.
type Task struct {
	Source string
	Seq    int64
	Ready  time.Time
}

// Callback is invoked with the task and a context that is cancelled when the
// task is cancelled while running. The scheduler counts the task as running
// until the callback returns; quota is released only at that moment.
type Callback func(ctx context.Context, task Task)

// SourceConfig configures a single source. Zero fields mean the corresponding
// limit is not enforced.
type SourceConfig struct {
	// MaxConcurrent caps the number of concurrently running tasks of the
	// source. Zero means unlimited.
	MaxConcurrent int
	// MinStartInterval is the minimum elapsed time between two consecutive
	// starts of tasks from this source. Zero means no interval restriction.
	MinStartInterval time.Duration
}

// Config configures a Scheduler. Sources not present in SourceLimits are
// treated as unlimited.
type Config struct {
	// MaxConcurrent caps the number of concurrently running tasks across all
	// sources. Must be positive.
	MaxConcurrent int
	SourceLimits  map[string]SourceConfig
}

func (c Config) clone() Config {
	src := make(map[string]SourceConfig, len(c.SourceLimits))
	for k, v := range c.SourceLimits {
		src[k] = v
	}
	return Config{MaxConcurrent: c.MaxConcurrent, SourceLimits: src}
}

// Handle is returned for every submitted task.
type Handle struct {
	task Task
	s    *Scheduler
}

// Task returns the task associated with the handle.
func (h *Handle) Task() Task { return h.task }

// Cancel cancels the task.
//
// If the task has not started, it is removed and will never run. If it is
// running, its context is cancelled; quota is released only once the running
// callback returns. Cancelling a finished task is a no-op.
func (h *Handle) Cancel() error {
	return h.s.Cancel(h.task.Seq)
}

type taskState int

const (
	statePending taskState = iota
	stateRunning
	stateDone
)

type entry struct {
	task   Task
	state  taskState
	index  int // heap index while pending
	cancel context.CancelFunc
}

type runEntry struct {
	e   *entry
	ctx context.Context
}

type sourceStat struct {
	running   int
	lastStart time.Time
}

// Scheduler dispatches ready tasks subject to global, per-source and
// per-source-interval limits. The zero value is not usable; create one with
// New.
type Scheduler struct {
	clock    Clock
	callback Callback

	mu      sync.Mutex
	config  Config
	pending *taskHeap
	bySeq   map[int64]*entry
	sources map[string]*sourceStat
	running int
	closed  bool

	inflight sync.WaitGroup

	// wakeCh is replaced and closed on every state change while mu is held.
	// The dispatch loop captures the current channel each iteration, so a
	// change can never be lost: either it happened before capture and is
	// observed directly, or it closes the captured channel.
	wakeCh chan struct{}
	done   chan struct{}
}

// New creates and starts a Scheduler using clock for all time decisions and
// callback for every started task.
func New(cfg Config, clock Clock, callback Callback) (*Scheduler, error) {
	if callback == nil {
		return nil, errors.New("dataeng: nil callback")
	}
	if clock == nil {
		return nil, errors.New("dataeng: nil clock")
	}
	if cfg.MaxConcurrent <= 0 {
		return nil, errors.New("dataeng: Config.MaxConcurrent must be positive")
	}
	for name, sc := range cfg.SourceLimits {
		if sc.MaxConcurrent < 0 || sc.MinStartInterval < 0 {
			return nil, errors.New("dataeng: negative limit for source " + name)
		}
	}
	s := &Scheduler{
		clock:    clock,
		callback: callback,
		config:   cfg.clone(),
		pending:  newTaskHeap(),
		bySeq:    make(map[int64]*entry),
		sources:  make(map[string]*sourceStat),
		wakeCh:   make(chan struct{}),
		done:     make(chan struct{}),
	}
	go s.loop()
	return s, nil
}

// Submit queues a task. The task becomes eligible once its Ready time has been
// reached according to the injected clock.
func (s *Scheduler) Submit(t Task) (*Handle, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	if _, exists := s.bySeq[t.Seq]; exists {
		return nil, ErrDuplicateSeq
	}
	e := &entry{task: t, state: statePending, index: -1}
	heap.Push(s.pending, e)
	s.bySeq[t.Seq] = e
	s.signalLocked()
	return &Handle{task: t, s: s}, nil
}

// Cancel cancels the task identified by seq. See Handle.Cancel for semantics.
func (s *Scheduler) Cancel(seq int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	e, ok := s.bySeq[seq]
	if !ok {
		return nil
	}
	switch e.state {
	case statePending:
		heap.Remove(s.pending, e.index)
		e.state = stateDone
		delete(s.bySeq, seq)
	case stateRunning:
		// Only signal; the running callback keeps its quota until it returns.
		if e.cancel != nil {
			e.cancel()
		}
	}
	return nil
}

// UpdateLimits atomically replaces all limits. Limits only affect tasks started
// after the update: already running tasks are never interrupted and keep their
// occupied quota.
func (s *Scheduler) UpdateLimits(cfg Config) error {
	if cfg.MaxConcurrent <= 0 {
		return errors.New("dataeng: Config.MaxConcurrent must be positive")
	}
	for name, sc := range cfg.SourceLimits {
		if sc.MaxConcurrent < 0 || sc.MinStartInterval < 0 {
			return errors.New("dataeng: negative limit for source " + name)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	s.config = cfg.clone()
	s.signalLocked()
	return nil
}

// Pending returns the number of tasks waiting to start.
func (s *Scheduler) Pending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending.Len()
}

// Running returns the number of tasks whose callback is currently in flight.
func (s *Scheduler) Running() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// Close stops accepting submissions, lets all in-flight callbacks finish, and
// stops the dispatch loop. Pending tasks never start after Close.
func (s *Scheduler) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.inflight.Wait()
		return
	}
	s.closed = true
	close(s.wakeCh)
	s.mu.Unlock()

	<-s.done
	s.inflight.Wait()
}

func (s *Scheduler) signalLocked() {
	if s.closed {
		return
	}
	close(s.wakeCh)
	s.wakeCh = make(chan struct{})
}

func (s *Scheduler) loop() {
	defer close(s.done)

	var timer Timer
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
		}
	}
	armTimer := func(d time.Duration) {
		t := s.clock.NewTimer(d)
		timer = t
		go func() {
			<-t.C()
			s.mu.Lock()
			s.signalLocked()
			s.mu.Unlock()
		}()
	}

	for {
		s.mu.Lock()
		stopTimer()

		if s.closed {
			s.mu.Unlock()
			return
		}

		var nextWake time.Time
		for {
			best, wake := s.planLocked()
			if best != nil && s.running < s.config.MaxConcurrent {
				s.startLocked(best)
				continue
			}
			if best == nil || s.running >= s.config.MaxConcurrent {
				nextWake = wake
			}
			break
		}

		if !nextWake.IsZero() {
			armTimer(nextWake.Sub(s.clock.Now()))
		}

		wakeCh := s.wakeCh
		s.mu.Unlock()

		<-wakeCh
	}
}

// planLocked scans pending tasks and returns:
//   - best: the highest-priority task startable right now (nil if none);
//   - wake: the earliest fake time at which any currently blocked task could
//     become startable, considering ready times and per-source interval or
//     concurrency limits. It is zero if nothing is time-blocked.
func (s *Scheduler) planLocked() (best *entry, wake time.Time) {
	now := s.clock.Now()
	for _, e := range s.pending.tasks {
		if e.state != statePending {
			continue
		}
		if e.task.Ready.After(now) {
			if wake.IsZero() || e.task.Ready.Before(wake) {
				wake = e.task.Ready
			}
			continue
		}
		stat := s.sources[e.task.Source]
		sc := s.config.SourceLimits[e.task.Source]
		if sc.MaxConcurrent > 0 && stat != nil && stat.running >= sc.MaxConcurrent {
			// Blocked on a running task of the same source; the unblock is
			// event-driven (completion), not time-driven.
			continue
		}
		if sc.MinStartInterval > 0 && stat != nil && !stat.lastStart.IsZero() {
			eligibleAt := stat.lastStart.Add(sc.MinStartInterval)
			if eligibleAt.After(now) {
				if wake.IsZero() || eligibleAt.Before(wake) {
					wake = eligibleAt
				}
				continue
			}
		}
		if best == nil ||
			e.task.Ready.Before(best.task.Ready) ||
			(e.task.Ready.Equal(best.task.Ready) && e.task.Seq < best.task.Seq) {
			best = e
		}
	}
	return best, wake
}

func (s *Scheduler) startLocked(e *entry) {
	heap.Remove(s.pending, e.index)
	e.state = stateRunning
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel

	stat := s.sources[e.task.Source]
	if stat == nil {
		stat = &sourceStat{}
		s.sources[e.task.Source] = stat
	}
	stat.running++
	stat.lastStart = s.clock.Now()
	s.running++

	s.inflight.Add(1)
	go s.run(&runEntry{e: e, ctx: ctx})
}

func (s *Scheduler) run(re *runEntry) {
	defer s.inflight.Done()
	defer func() {
		// A panicking callback must not leak quota or kill the process.
		_ = recover()
		s.finish(re.e)
	}()
	s.callback(re.ctx, re.e.task)
}

func (s *Scheduler) finish(e *entry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.state == stateDone {
		return
	}
	e.state = stateDone
	e.cancel = nil
	delete(s.bySeq, e.task.Seq)

	if stat := s.sources[e.task.Source]; stat != nil && stat.running > 0 {
		stat.running--
	}
	s.running--
	if s.closed {
		return
	}
	s.signalLocked()
}
