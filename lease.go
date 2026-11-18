package formal

import (
	"errors"
	"sync"
	"time"
)

// Errors returned by Manager operations.
var (
	// ErrNotHeld is returned when no live lease exists for the object.
	ErrNotHeld = errors.New("formal: lease is not held")
	// ErrStaleToken is returned when the caller presents a lease that has
	// been superseded by a newer holder (a higher fencing epoch).
	ErrStaleToken = errors.New("formal: stale lease token")
	// ErrHeldByOther is returned when an operation requires an object that
	// is currently held by another, non-expired lease.
	ErrHeldByOther = errors.New("formal: object held by another client")
	// ErrNotDirty is returned when a flush is requested for a clean lease.
	ErrNotDirty = errors.New("formal: lease has no dirty data to write back")
)

// Sink persists object data. Implementations must be safe for concurrent use.
type Sink interface {
	// WriteBack persists data for object under fencing epoch.
	// Implementations should reject writes whose epoch is lower than an
	// epoch already accepted for the same object (FencingStore does).
	WriteBack(object string, epoch uint64, data []byte) error
}

// Lease is an immutable snapshot of a granted lease. Epoch is the fencing
// token: monotonic per object and bumped on every ownership transfer.
type Lease struct {
	Object   string
	Holder   string
	Epoch    uint64
	Deadline time.Time
}

// state is the mutable per-object record, touched only under Manager.mu.
type state struct {
	lease  Lease
	exists bool
	dirty  bool
	data   []byte
}

// opState is per-operation bookkeeping. A fresh instance is created for every
// operation invocation, so interleaved operations never share terminal flags.
type opState struct {
	terminal  bool // terminal outcome already produced for the operation
	outcome   Lease
	err       error
	victim    Lease
	hasVictim bool
}

// Manager coordinates leases for named objects. Every transition is expressed
// as an ordered list of idempotent steps; production methods run them under one
// lock, while the tests execute the same step lists without the lock to
// enumerate interleavings.
type Manager struct {
	mu      sync.Mutex
	objects map[string]*state
	sink    Sink
	now     func() time.Time
	ttl     time.Duration
}

// Option customizes a Manager.
type Option func(*Manager)

// WithClock injects a clock source, mainly for deterministic tests.
func WithClock(now func() time.Time) Option {
	return func(m *Manager) { m.now = now }
}

// WithTTL sets the lease time-to-live.
func WithTTL(ttl time.Duration) Option {
	return func(m *Manager) { m.ttl = ttl }
}

// NewManager creates a Manager backed by sink.
func NewManager(sink Sink, opts ...Option) *Manager {
	m := &Manager{
		objects: make(map[string]*state),
		sink:    sink,
		now:     time.Now,
		ttl:     time.Minute,
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

func (m *Manager) entry(object string) *state {
	st := m.objects[object]
	if st == nil {
		st = &state{}
		m.objects[object] = st
	}
	return st
}

// step is one fragment of a lease operation. A fresh opState is supplied per
// operation; steps consult it only to detect their own termination.
type step func(st *state, op *opState) (Lease, error, bool)

// run executes a complete operation atomically under the manager lock.
func (m *Manager) run(object string, build func(m *Manager, st *state) []step) (Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.entry(object)
	op := &opState{}
	for _, s := range build(m, st) {
		l, err, done := s(st, op)
		if done {
			return l, err
		}
	}
	panic("formal: operation produced no terminal step")
}

// Acquire grants an exclusive lease for object to holder. It fails when the
// object is held by another client whose lease has not expired.
func (m *Manager) Acquire(object, holder string) (Lease, error) {
	return m.run(object, func(m *Manager, st *state) []step {
		return m.acquireScript(object, holder)
	})
}

func (m *Manager) acquireScript(object, holder string) []step {
	return []step{
		// Step 1: reject only a live, conflicting holder.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.exists && st.lease.Holder != holder && st.lease.Deadline.After(m.now()) {
				op.terminal, op.err = true, ErrHeldByOther
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		// Step 2: publish the lease with a fencing epoch.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			next := uint64(1)
			if st.exists {
				next = st.lease.Epoch + 1
			}
			l := Lease{
				Object:   object,
				Holder:   holder,
				Epoch:    next,
				Deadline: m.now().Add(m.ttl),
			}
			st.lease, st.exists, st.dirty, st.data = l, true, false, nil
			op.terminal, op.outcome = true, l
			return l, nil, true
		},
	}
}

// Renew extends the deadline of the lease identified by token. A token from a
// superseded holder is rejected: an old lease receipt can never outvote the
// current holder.
func (m *Manager) Renew(token Lease) (Lease, error) {
	return m.run(token.Object, func(m *Manager, st *state) []step {
		return m.renewScript(token)
	})
}

func (m *Manager) renewScript(token Lease) []step {
	return []step{
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.exists {
				op.terminal, op.err = true, ErrNotHeld
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.lease.Epoch != token.Epoch || st.lease.Holder != token.Holder {
				op.terminal, op.err = true, ErrStaleToken
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.lease.Deadline.After(m.now()) {
				op.terminal, op.err = true, ErrNotHeld
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			st.lease.Deadline = m.now().Add(m.ttl)
			l := st.lease
			op.terminal, op.outcome = true, l
			return l, nil, true
		},
	}
}

// MarkDirty records buffered, not-yet-persisted data for the held lease.
func (m *Manager) MarkDirty(token Lease, data []byte) error {
	_, err := m.run(token.Object, func(m *Manager, st *state) []step {
		return m.markDirtyScript(token, data)
	})
	return err
}

func (m *Manager) markDirtyScript(token Lease, data []byte) []step {
	return []step{
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.exists {
				op.terminal, op.err = true, ErrNotHeld
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.lease.Epoch != token.Epoch || st.lease.Holder != token.Holder {
				op.terminal, op.err = true, ErrStaleToken
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			buf := make([]byte, len(data))
			copy(buf, data)
			st.dirty, st.data = true, buf
			op.terminal = true
			return Lease{}, nil, true
		},
	}
}

// Flush writes dirty data back through the Sink while keeping the lease held.
// The fencing epoch travels with the write, so a superseded holder can never
// overwrite newer data even if it flushes late.
func (m *Manager) Flush(token Lease) (Lease, error) {
	return m.run(token.Object, func(m *Manager, st *state) []step {
		return m.flushScript(token)
	})
}

func (m *Manager) flushScript(token Lease) []step {
	return []step{
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.exists {
				op.terminal, op.err = true, ErrNotHeld
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.lease.Epoch != token.Epoch || st.lease.Holder != token.Holder {
				op.terminal, op.err = true, ErrStaleToken
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.lease.Deadline.After(m.now()) {
				op.terminal, op.err = true, ErrNotHeld
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.dirty {
				op.terminal, op.err = true, ErrNotDirty
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		// Hand buffered data to the sink under the current fencing token.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if err := m.sink.WriteBack(token.Object, token.Epoch, st.data); err != nil {
				op.terminal, op.err = true, err
				return Lease{}, err, true
			}
			st.dirty, st.data = false, nil
			l := st.lease
			op.terminal, op.outcome = true, l
			return l, nil, true
		},
	}
}

// Break interrupts the lease identified by token: dirty data is flushed first,
// and only then is the lease released. A stale token neither flushes nor
// releases anything.
func (m *Manager) Break(token Lease) error {
	_, err := m.run(token.Object, func(m *Manager, st *state) []step {
		return m.breakScript(token)
	})
	return err
}

func (m *Manager) breakScript(token Lease) []step {
	return []step{
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !st.exists {
				op.terminal, op.err = true, ErrNotHeld
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.lease.Epoch != token.Epoch || st.lease.Holder != token.Holder {
				op.terminal, op.err = true, ErrStaleToken
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		// Flush-before-release: write back any dirt while still the holder.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.dirty {
				if err := m.sink.WriteBack(token.Object, token.Epoch, st.data); err != nil {
					op.terminal, op.err = true, err
					return Lease{}, err, true
				}
				st.dirty, st.data = false, nil
			}
			return Lease{}, nil, false
		},
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			st.exists, st.lease, st.dirty, st.data = false, Lease{}, false, nil
			op.terminal = true
			return Lease{}, nil, true
		},
	}
}

// Steal forcefully transfers object to thief. The victim's dirty data is
// flushed under the victim's fencing epoch before ownership moves; the thief
// receives a strictly higher epoch, so every previous lease receipt becomes
// stale. Unheld or expired objects can be stolen as well.
func (m *Manager) Steal(object, thief string) (Lease, error) {
	return m.run(object, func(m *Manager, st *state) []step {
		return m.stealScript(object, thief)
	})
}

func (m *Manager) stealScript(object, thief string) []step {
	return []step{
		// A client already holding the object cannot steal it from itself.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.exists && st.lease.Holder == thief {
				op.terminal, op.err = true, ErrHeldByOther
				return Lease{}, op.err, true
			}
			return Lease{}, nil, false
		},
		// Observe the victim and capture its fencing token.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if st.exists {
				op.victim, op.hasVictim = st.lease, true
			}
			return Lease{}, nil, false
		},
		// Flush victim dirt under the captured epoch. The fencing sink
		// rejects a duplicate write, turning a lost race into an error.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !op.hasVictim {
				return Lease{}, nil, false
			}
			if !st.exists || st.lease.Epoch != op.victim.Epoch || st.lease.Holder != op.victim.Holder {
				op.terminal, op.err = true, ErrStaleToken
				return Lease{}, op.err, true
			}
			if st.dirty {
				if err := m.sink.WriteBack(object, op.victim.Epoch, st.data); err != nil {
					op.terminal, op.err = true, err
					return Lease{}, err, true
				}
				st.dirty, st.data = false, nil
			}
			return Lease{}, nil, false
		},
		// Transfer ownership with a strictly larger fencing epoch.
		func(st *state, op *opState) (Lease, error, bool) {
			if op.terminal {
				return op.outcome, op.err, true
			}
			if !op.hasVictim {
				if st.exists {
					op.terminal, op.err = true, ErrStaleToken
					return Lease{}, op.err, true
				}
				l := Lease{Object: object, Holder: thief, Epoch: 1, Deadline: m.now().Add(m.ttl)}
				st.lease, st.exists, st.dirty, st.data = l, true, false, nil
				op.terminal, op.outcome = true, l
				return l, nil, true
			}
			if !st.exists || st.lease.Epoch != op.victim.Epoch || st.lease.Holder != op.victim.Holder {
				op.terminal, op.err = true, ErrStaleToken
				return Lease{}, op.err, true
			}
			l := Lease{
				Object:   object,
				Holder:   thief,
				Epoch:    op.victim.Epoch + 1,
				Deadline: m.now().Add(m.ttl),
			}
			st.lease, st.exists, st.dirty, st.data = l, true, false, nil
			op.terminal, op.outcome = true, l
			return l, nil, true
		},
	}
}
