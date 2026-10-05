// Package modlib implements a module library whose configuration can be
// hot-switched at runtime. Each switch seals the current generation and
// opens a new one: tasks started before the switch keep running to
// completion in their original generation, while tasks started after the
// switch bind only to the new generation.
//
// WaitOld blocks until every generation that was already sealed at the
// moment of the call has fully drained. Generations sealed later (by
// switches that happen after the call) never extend a pending WaitOld.
package modlib

import "sync"

// State describes the lifecycle state of a task.
type State int

const (
	Active State = iota
	Finished
	Cancelled
)

func (s State) String() string {
	switch s {
	case Active:
		return "active"
	case Finished:
		return "finished"
	case Cancelled:
		return "cancelled"
	}
	return "unknown"
}

// Config is an opaque module configuration. The library only carries it;
// callers decide its meaning.
type Config struct {
	Name    string
	Version int
}

// Task is a unit of work bound to exactly one generation: the generation
// that was current when Start was called.
type Task struct {
	lib *Library
	id  uint64
	gen uint64
}

// ID returns the library-unique task identifier.
func (t *Task) ID() uint64 { return t.id }

// Gen returns the generation the task is bound to.
func (t *Task) Gen() uint64 { return t.gen }

// Finish marks the task as successfully completed. It is idempotent;
// calls after a Cancel are no-ops.
func (t *Task) Finish() { t.lib.complete(t, Finished) }

// Cancel marks the task as cancelled and releases it from its
// generation. It is idempotent; calls after a Finish are no-ops.
func (t *Task) Cancel() { t.lib.complete(t, Cancelled) }

// generation tracks the tasks of one sealed or current generation.
type generation struct {
	cfg   Config
	tasks map[uint64]State
	wg    sync.WaitGroup
}

// Library is a hot-swappable module library. The zero value is not
// usable; construct one with New.
type Library struct {
	mu     sync.Mutex
	gens   []*generation // gens[i] is generation i; the last entry is current
	nextID uint64

	// waitOldSnapshotHook, if non-nil, is invoked by WaitOld right after it
	// snapshots the sealed generations. Used by tests only.
	waitOldSnapshotHook func()
}

// New creates a Library holding cfg as its initial (generation 0)
// configuration.
func New(cfg Config) *Library {
	l := &Library{}
	l.gens = append(l.gens, &generation{cfg: cfg, tasks: map[uint64]State{}})
	return l
}

// Current returns the current generation number and its configuration.
func (l *Library) Current() (uint64, Config) {
	l.mu.Lock()
	defer l.mu.Unlock()
	g := l.gens[len(l.gens)-1]
	return uint64(len(l.gens) - 1), g.cfg
}

// Switch seals the current generation and opens a new one carrying cfg.
// Already running tasks of older generations are unaffected and continue
// to completion. It returns the new generation number.
func (l *Library) Switch(cfg Config) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.gens = append(l.gens, &generation{cfg: cfg, tasks: map[uint64]State{}})
	return uint64(len(l.gens) - 1)
}

// Start binds a new task to the generation that is current right now and
// returns it. The task keeps belonging to that generation even if a
// Switch happens immediately afterwards.
func (l *Library) Start() *Task {
	l.mu.Lock()
	defer l.mu.Unlock()
	gen := uint64(len(l.gens) - 1)
	g := l.gens[gen]
	id := l.nextID
	l.nextID++
	g.tasks[id] = Active
	g.wg.Add(1)
	return &Task{lib: l, id: id, gen: gen}
}

func (l *Library) complete(t *Task, st State) {
	l.mu.Lock()
	defer l.mu.Unlock()
	g := l.gens[t.gen]
	if g.tasks[t.id] != Active {
		return
	}
	g.tasks[t.id] = st
	g.wg.Done()
}

// WaitOld blocks until every generation sealed at call time — i.e. all
// generations older than the one current when WaitOld is invoked — has
// no active tasks left. The currently open generation is never waited
// on, and generations sealed by later switches do not extend the wait.
func (l *Library) WaitOld() {
	l.mu.Lock()
	sealed := make([]*sync.WaitGroup, 0, len(l.gens)-1)
	for _, g := range l.gens[:len(l.gens)-1] {
		sealed = append(sealed, &g.wg)
	}
	hook := l.waitOldSnapshotHook
	l.mu.Unlock()
	if hook != nil {
		hook()
	}
	for _, wg := range sealed {
		wg.Wait()
	}
}

// Snapshot returns, for every generation, a copy of its task set mapping
// task ID to state. It is intended for inspection and verification.
func (l *Library) Snapshot() []map[uint64]State {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]map[uint64]State, len(l.gens))
	for i, g := range l.gens {
		m := make(map[uint64]State, len(g.tasks))
		for id, st := range g.tasks {
			m[id] = st
		}
		out[i] = m
	}
	return out
}
