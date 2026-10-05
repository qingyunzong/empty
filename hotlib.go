// Package hotlib implements a module library whose configuration can be
// hot-switched at runtime.
//
// Switching installs a new generation: tasks already running in older
// generations keep running to completion (they are never cancelled by a
// switch), while tasks started after the switch bind only to the new
// generation. WaitOld waits only for the generations that were already
// sealed at the moment it is called, so it cannot be extended
// indefinitely by later switches.
package hotlib

import (
	"context"
	"sync"
)

// Config is an opaque module configuration. The library only stores and
// hands it back; its meaning is defined by the caller.
type Config struct {
	Name  string
	Value int
}

type generation struct {
	id     uint64
	cfg    Config
	sealed bool
	live   int
	tasks  map[uint64]struct{}
	done   chan struct{} // closed once sealed and fully drained
}

// Task is a handle to one running task bound to a single generation.
type Task struct {
	id     uint64
	gen    uint64
	cancel context.CancelFunc
	done   chan struct{}
	err    error // set before done is closed
}

// ID returns the library-wide unique task ID.
func (t *Task) ID() uint64 { return t.id }

// Generation returns the ID of the generation the task is bound to.
func (t *Task) Generation() uint64 { return t.gen }

// Done is closed when the task function has returned and the task has
// been detached from its generation.
func (t *Task) Done() <-chan struct{} { return t.done }

// Cancel cancels the task's context. It does not wait for the task to
// finish; use Done for that.
func (t *Task) Cancel() { t.cancel() }

// Err reports the task's context error (context.Canceled or
// context.DeadlineExceeded) observed when the task returned, or nil if
// the task returned without its context being done. It is only
// meaningful after Done is closed.
func (t *Task) Err() error { return t.err }

// Library is a hot-swappable module library. The zero value is not
// usable; construct it with New.
type Library struct {
	mu       sync.Mutex
	cur      *generation
	olds     map[uint64]*generation // sealed generations not yet drained
	nextGen  uint64
	nextTask uint64
}

// New returns a Library whose initial generation uses cfg.
func New(cfg Config) *Library {
	l := &Library{olds: make(map[uint64]*generation)}
	l.cur = &generation{id: l.nextGen, cfg: cfg, tasks: make(map[uint64]struct{}), done: make(chan struct{})}
	l.nextGen++
	return l
}

// Current returns the ID and configuration of the generation that new
// tasks will bind to.
func (l *Library) Current() (uint64, Config) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cur.id, l.cur.cfg
}

// Start binds fn to the current generation and runs it in its own
// goroutine. fn receives a context that is cancelled by Task.Cancel;
// switching generations never cancels it.
func (l *Library) Start(fn func(ctx context.Context)) *Task {
	l.mu.Lock()
	g := l.cur
	id := l.nextTask
	l.nextTask++
	ctx, cancel := context.WithCancel(context.Background())
	t := &Task{id: id, gen: g.id, cancel: cancel, done: make(chan struct{})}
	g.live++
	g.tasks[id] = struct{}{}
	l.mu.Unlock()

	go func() {
		fn(ctx)
		err := ctx.Err()
		l.mu.Lock()
		delete(g.tasks, id)
		g.live--
		if g.sealed && g.live == 0 {
			close(g.done)
			delete(l.olds, g.id)
		}
		l.mu.Unlock()
		t.err = err
		close(t.done)
	}()
	return t
}

// Switch seals the current generation and installs a new one configured
// with cfg. Tasks of the sealed generation keep running to completion;
// subsequent Start calls bind only to the new generation. It returns the
// ID of the sealed generation.
func (l *Library) Switch(cfg Config) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	old := l.cur
	old.sealed = true
	if old.live == 0 {
		close(old.done)
	} else {
		l.olds[old.id] = old
	}
	l.cur = &generation{id: l.nextGen, cfg: cfg, tasks: make(map[uint64]struct{}), done: make(chan struct{})}
	l.nextGen++
	return old.id
}

// WaitOld blocks until every generation that was already sealed at the
// moment of the call has fully drained. Generations sealed by later
// Switch calls — and the generation current at call time — are not
// waited for, so WaitOld cannot be extended indefinitely by new
// generations.
func (l *Library) WaitOld() { <-l.OldBarrier() }

// OldBarrier returns a channel that is closed once every generation
// sealed at the moment of the call has fully drained. It captures the
// set of generations synchronously, before returning.
func (l *Library) OldBarrier() <-chan struct{} {
	l.mu.Lock()
	chans := make([]chan struct{}, 0, len(l.olds))
	for _, g := range l.olds {
		chans = append(chans, g.done)
	}
	l.mu.Unlock()
	out := make(chan struct{})
	go func() {
		for _, ch := range chans {
			<-ch
		}
		close(out)
	}()
	return out
}

// Snapshot returns the set of live task IDs per generation ID, covering
// both the current generation and sealed generations that have not
// drained yet. It is intended for verification and monitoring.
func (l *Library) Snapshot() map[uint64][]uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[uint64][]uint64, len(l.olds)+1)
	add := func(g *generation) {
		ids := make([]uint64, 0, len(g.tasks))
		for id := range g.tasks {
			ids = append(ids, id)
		}
		out[g.id] = ids
	}
	add(l.cur)
	for _, g := range l.olds {
		add(g)
	}
	return out
}
