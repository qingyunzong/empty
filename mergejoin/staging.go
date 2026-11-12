package mergejoin

import (
	"context"
	"sync"
)

// StagingWriter appends rows of one side for one key group.
type StagingWriter[P any] interface {
	Append(ctx context.Context, row Row[P]) error
	Close() error
}

// StagingReader replays rows written for one side and key. Rewind returns
// the reader to the first row so the same group can be scanned repeatedly,
// which the nested-loop product requires. Discard deletes the group's
// staged data; Close releases the reader's own resources.
type StagingReader[P any] interface {
	Next(ctx context.Context) (Row[P], error)
	Rewind() error
	Discard(ctx context.Context) error
	Close() error
}

// Staging is the caller-injected, replayable spill storage. Implementations
// must tolerate repeated full replays and may use disk, object storage or
// any other backing. The Joiner calls Close exactly once when the run ends.
type Staging[L, R any] interface {
	NewLeftWriter(ctx context.Context, key int64) (StagingWriter[L], error)
	NewRightWriter(ctx context.Context, key int64) (StagingWriter[R], error)
	NewLeftReader(ctx context.Context, key int64) (StagingReader[L], error)
	NewRightReader(ctx context.Context, key int64) (StagingReader[R], error)
	Close() error
}

// NewStagingFunc constructs a fresh staging handle for one Joiner run.
type NewStagingFunc[L, R any] func() (Staging[L, R], error)

// memStage is one per-key, per-side row buffer inside MemStaging.
type memStage[P any] struct {
	rows         []Row[P]
	writerClosed bool
	discarded    bool
}

// MemStaging is an in-memory Staging implementation, useful as a default
// and in tests. It preserves insertion order, supports arbitrary replays
// and keeps groups isolated until they are discarded or the handle closes.
type MemStaging[L, R any] struct {
	mu     sync.Mutex
	closed bool
	left   map[int64]*memStage[L]
	right  map[int64]*memStage[R]
}

// NewMemStaging creates an empty in-memory staging handle.
func NewMemStaging[L, R any]() *MemStaging[L, R] {
	return &MemStaging[L, R]{
		left:  make(map[int64]*memStage[L]),
		right: make(map[int64]*memStage[R]),
	}
}

func (m *MemStaging[L, R]) groupLeft(key int64, create bool) (*memStage[L], error) {
	g, ok := m.left[key]
	if !ok && create {
		g = &memStage[L]{}
		m.left[key] = g
	}
	if g == nil {
		return nil, ErrClosed
	}
	if g.discarded {
		return nil, ErrClosed
	}
	return g, nil
}

func (m *MemStaging[L, R]) groupRight(key int64, create bool) (*memStage[R], error) {
	g, ok := m.right[key]
	if !ok && create {
		g = &memStage[R]{}
		m.right[key] = g
	}
	if g == nil {
		return nil, ErrClosed
	}
	if g.discarded {
		return nil, ErrClosed
	}
	return g, nil
}

type memWriter[P any] struct {
	stage *memStage[P]
	gate  *sync.Mutex
}

func (w *memWriter[P]) Append(_ context.Context, row Row[P]) error {
	w.gate.Lock()
	defer w.gate.Unlock()
	if w.stage.writerClosed || w.stage.discarded {
		return ErrClosed
	}
	w.stage.rows = append(w.stage.rows, row)
	return nil
}

func (w *memWriter[P]) Close() error {
	w.gate.Lock()
	defer w.gate.Unlock()
	if w.stage.writerClosed {
		return ErrClosed
	}
	w.stage.writerClosed = true
	return nil
}

type memReader[P any] struct {
	stage *memStage[P]
	gate  *sync.Mutex
	pos   int
}

func (r *memReader[P]) Next(_ context.Context) (Row[P], error) {
	r.gate.Lock()
	defer r.gate.Unlock()
	if r.stage.discarded {
		return Row[P]{}, ErrClosed
	}
	if r.pos >= len(r.stage.rows) {
		return Row[P]{}, errEOF()
	}
	row := r.stage.rows[r.pos]
	r.pos++
	return row, nil
}

func (r *memReader[P]) Rewind() error {
	r.gate.Lock()
	defer r.gate.Unlock()
	if r.stage.discarded {
		return ErrClosed
	}
	r.pos = 0
	return nil
}

func (r *memReader[P]) Discard(_ context.Context) error {
	r.gate.Lock()
	defer r.gate.Unlock()
	r.stage.rows = nil
	r.stage.discarded = true
	return nil
}

func (r *memReader[P]) Close() error {
	r.gate.Lock()
	defer r.gate.Unlock()
	r.pos = len(r.stage.rows)
	return nil
}

// NewLeftWriter returns an append writer for a left-side key group.
func (m *MemStaging[L, R]) NewLeftWriter(_ context.Context, key int64) (StagingWriter[L], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	g, err := m.groupLeft(key, true)
	if err != nil {
		return nil, err
	}
	return &memWriter[L]{stage: g, gate: &m.mu}, nil
}

// NewRightWriter returns an append writer for a right-side key group.
func (m *MemStaging[L, R]) NewRightWriter(_ context.Context, key int64) (StagingWriter[R], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	g, err := m.groupRight(key, true)
	if err != nil {
		return nil, err
	}
	return &memWriter[R]{stage: g, gate: &m.mu}, nil
}

// NewLeftReader returns a replayable reader for a left-side key group.
func (m *MemStaging[L, R]) NewLeftReader(_ context.Context, key int64) (StagingReader[L], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	g, err := m.groupLeft(key, false)
	if err != nil {
		return nil, err
	}
	return &memReader[L]{stage: g, gate: &m.mu}, nil
}

// NewRightReader returns a replayable reader for a right-side key group.
func (m *MemStaging[L, R]) NewRightReader(_ context.Context, key int64) (StagingReader[R], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	g, err := m.groupRight(key, false)
	if err != nil {
		return nil, err
	}
	return &memReader[R]{stage: g, gate: &m.mu}, nil
}

// Close marks the handle closed and releases every retained group.
func (m *MemStaging[L, R]) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	m.left = nil
	m.right = nil
	return nil
}

// LeftGroupSize reports the staged left-row count for key. It is intended
// for diagnostics and tests.
func (m *MemStaging[L, R]) LeftGroupSize(key int64) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if g, ok := m.left[key]; ok {
		return len(g.rows)
	}
	return 0
}

// RightGroupSize reports the staged right-row count for key. It is intended
// for diagnostics and tests.
func (m *MemStaging[L, R]) RightGroupSize(key int64) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if g, ok := m.right[key]; ok {
		return len(g.rows)
	}
	return 0
}
