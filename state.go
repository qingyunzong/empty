package dataeng

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrNoState means that the state store has no checkpoint. Callers should
	// take a new snapshot instead of guessing a starting LSN.
	ErrNoState = errors.New("sqlserver cdc: no checkpoint state")
)

// State is the durable CDC checkpoint. Watermark is the greatest LSN for
// which every change row has been applied. Position is the last individual
// row applied and may be inside Watermark's LSN when a batch stopped in the
// middle of a transaction.
type State struct {
	Position        Position `json:"position"`
	Watermark       LSN      `json:"watermark"`
	SnapshotLSN     LSN      `json:"snapshot_lsn,omitempty"`
	PendingSnapshot bool     `json:"pending_snapshot,omitempty"`
}

// CDCState is an alias for State.
type CDCState = State

// NewState returns a zero checkpoint.
func NewState() State {
	return State{}
}

// IsZero reports whether no checkpoint or snapshot is recorded.
func (s State) IsZero() bool {
	return !s.PendingSnapshot && s.Position.IsZero() && s.Watermark.IsZero() && s.SnapshotLSN.IsZero()
}

// Clone returns a deep copy of the state.
func (s State) Clone() State {
	s.Position.UpdateMask = append([]byte(nil), s.Position.UpdateMask...)
	s.Position.StartLSN = s.Position.StartLSN.Bytes()
	s.Position.SeqVal = s.Position.SeqVal.Bytes()
	s.Watermark = s.Watermark.Bytes()
	s.SnapshotLSN = s.SnapshotLSN.Bytes()
	return s
}

// Checkpoint returns the fully consumed LSN watermark.
func (s State) Checkpoint() LSN {
	return s.Watermark.Bytes()
}

// LastPosition returns the last individual change position.
func (s State) LastPosition() Position {
	position := s.Position
	position.StartLSN = position.StartLSN.Bytes()
	position.SeqVal = position.SeqVal.Bytes()
	position.UpdateMask = append([]byte(nil), position.UpdateMask...)
	return position
}

// ObservePosition records a single change row. Positions older than or equal
// to the current position are ignored, which makes replays idempotent.
func (s *State) ObservePosition(position Position) bool {
	if ComparePositions(position, s.Position) <= 0 {
		return false
	}
	s.Position = Position{
		StartLSN:   position.StartLSN.Bytes(),
		SeqVal:     position.SeqVal.Bytes(),
		Operation:  position.Operation,
		UpdateMask: append([]byte(nil), position.UpdateMask...),
	}
	return true
}

// Observe records a change row.
func (s *State) Observe(row ChangeRow) bool {
	return s.ObservePosition(row.Position())
}

// CompleteThrough marks every change through lsn as applied. Watermark only
// moves forward. The LSN must not be advanced while rows at that LSN are
// still pending.
func (s *State) CompleteThrough(lsn LSN) {
	if CompareLSN(lsn, s.Watermark) > 0 {
		s.Watermark = lsn.Bytes()
	}
}

// CompleteBatch marks a fully consumed query upper bound as applied.
func (s *State) CompleteBatch(upTo LSN) {
	s.CompleteThrough(upTo)
}

// ResetToSnapshot records the point from which a fresh snapshot was taken.
// The next CDC query starts just after snapshotLSN.
func (s *State) ResetToSnapshot(snapshotLSN LSN) {
	s.Position = Position{}
	s.Watermark = snapshotLSN.Bytes()
	s.SnapshotLSN = snapshotLSN.Bytes()
	s.PendingSnapshot = false
}

// MarkSnapshotRequired records that the current checkpoint is unusable and a
// new snapshot must be taken.
func (s *State) MarkSnapshotRequired() {
	s.PendingSnapshot = true
}

// NeedsSnapshot reports whether a snapshot must be taken before CDC resumes.
func (s State) NeedsSnapshot() bool {
	return s.PendingSnapshot || s.Watermark.IsZero()
}

// Apply combines raw CDC rows and advances the state position through the
// resulting changes. It does not advance Watermark; call CompleteThrough once
// the entire query interval has been consumed.
func (s *State) Apply(rows []ChangeRow) ([]Change, error) {
	changes, err := CombineChanges(rows)
	if err != nil {
		return nil, err
	}
	changes = FilterChangesAfter(changes, s.Position)
	for _, change := range changes {
		s.ObservePosition(change.Position())
	}
	return changes, nil
}

// StateStore persists a checkpoint. Load should return ErrNoState when the
// connector has never completed a snapshot.
type StateStore interface {
	Load(ctx context.Context) (State, error)
	Save(ctx context.Context, state State) error
}

// Store is an alias for StateStore.
type Store = StateStore

// MemoryStore is an in-process StateStore useful for tests and short-lived
// connectors.
type MemoryStore struct {
	mu     sync.RWMutex
	state  State
	loaded bool
}

// NewMemoryStore creates a memory-backed store. The optional initial state is
// treated as already saved.
func NewMemoryStore(initial ...State) *MemoryStore {
	store := &MemoryStore{}
	if len(initial) > 0 {
		store.state = initial[0].Clone()
		store.loaded = true
	}
	return store
}

// NewMemoryStateStore is an alias for NewMemoryStore.
func NewMemoryStateStore(initial ...State) *MemoryStore {
	return NewMemoryStore(initial...)
}

// Load returns the saved state or ErrNoState.
func (m *MemoryStore) Load(context.Context) (State, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if !m.loaded {
		return State{}, ErrNoState
	}
	return m.state.Clone(), nil
}

// Save replaces the saved state.
func (m *MemoryStore) Save(_ context.Context, state State) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state.Clone()
	m.loaded = true
	return nil
}

// State returns the in-memory state without treating an empty store as an
// error.
func (m *MemoryStore) State() State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.Clone()
}
