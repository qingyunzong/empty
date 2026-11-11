package q190

import (
	"context"
	"sync"
)

// Completion records one committed business effect and survives packet ID
// reuse, so tests can count committed effects even after the live record has
// been replaced by a newer generation.
type Completion struct {
	PacketID   uint16
	Generation int64
}

// MemoryHooks inject failures at the durable boundaries of MemoryStore. Every
// hook is invoked while the store lock is held. A non-nil return aborts the
// operation at that boundary; when a Commit hook fails, Commit returns the
// error and all staged changes are discarded, simulating a crash that never
// reached durable storage. A nil hook or one returning nil is transparent.
type MemoryHooks struct {
	OnBegin       func(packetID uint16) error
	OnPutPublish  func(rec Record) error
	OnPutComplete func(rec Record) error
	OnCommit      func(rec *Record) error
	OnClear       func() error
	OnLoad        func(packetID uint16) error
}

// MemoryStore is a reference in-memory Store.
//
// Its transactions are serializable: Begin takes a single store-wide lock and
// Commit or Rollback releases it, so transactions never overlap. It is safe
// for concurrent use and also serves as a crash-boundary test double through
// MemoryHooks.
type MemoryStore struct {
	mu      sync.Mutex
	records map[uint16]Record
	history []Completion
	hooks   MemoryHooks
}

// NewMemoryStore creates an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[uint16]Record)}
}

// SetHooks replaces the failure-injection hooks. It is intended for tests and
// must not be called while a transaction is open.
func (s *MemoryStore) SetHooks(hooks MemoryHooks) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks = hooks
}

// Begin implements Store.
func (s *MemoryStore) Begin(_ context.Context) (Tx, error) {
	s.mu.Lock()
	if s.hooks.OnBegin != nil {
		if err := s.hooks.OnBegin(0); err != nil {
			s.mu.Unlock()
			return nil, err
		}
	}
	return &MemoryTx{store: s, staged: make(map[uint16]Record)}, nil
}

// Load implements Store.
func (s *MemoryStore) Load(_ context.Context, packetID uint16) (*Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hooks.OnLoad != nil {
		if err := s.hooks.OnLoad(packetID); err != nil {
			return nil, err
		}
	}
	rec, ok := s.records[packetID]
	if !ok {
		return nil, nil
	}
	rec.Payload = append([]byte(nil), rec.Payload...)
	return &rec, nil
}

// Clear implements Store.
func (s *MemoryStore) Clear(_ context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hooks.OnClear != nil {
		if err := s.hooks.OnClear(); err != nil {
			return err
		}
	}
	s.records = make(map[uint16]Record)
	return nil
}

// Completions returns a copy of every committed completion in order.
func (s *MemoryStore) Completions() []Completion {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Completion, len(s.history))
	copy(out, s.history)
	return out
}

// Snapshot returns a copy of the live records keyed by packet ID.
func (s *MemoryStore) Snapshot() map[uint16]Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[uint16]Record, len(s.records))
	for id, rec := range s.records {
		rec.Payload = append([]byte(nil), rec.Payload...)
		out[id] = rec
	}
	return out
}

// MemoryTx is the transaction type returned by MemoryStore.Begin.
type MemoryTx struct {
	store  *MemoryStore
	staged map[uint16]Record
	closed bool
}

// Record implements Tx.
func (t *MemoryTx) Record(packetID uint16) (*Record, error) {
	if rec, ok := t.staged[packetID]; ok {
		rec.Payload = append([]byte(nil), rec.Payload...)
		return &rec, nil
	}
	if rec, ok := t.store.records[packetID]; ok {
		rec.Payload = append([]byte(nil), rec.Payload...)
		return &rec, nil
	}
	return nil, nil
}

// PutPublish implements Tx.
func (t *MemoryTx) PutPublish(rec Record) error {
	if t.store.hooks.OnPutPublish != nil {
		if err := t.store.hooks.OnPutPublish(rec); err != nil {
			return err
		}
	}
	rec.Payload = append([]byte(nil), rec.Payload...)
	t.staged[rec.PacketID] = rec
	return nil
}

// PutComplete implements Tx.
func (t *MemoryTx) PutComplete(rec Record) error {
	rec.Phase = PhaseComplete
	if t.store.hooks.OnPutComplete != nil {
		if err := t.store.hooks.OnPutComplete(rec); err != nil {
			return err
		}
	}
	rec.Payload = append([]byte(nil), rec.Payload...)
	t.staged[rec.PacketID] = rec
	return nil
}

// Underlying implements Tx. The MemoryStore has no native transaction object,
// so the MemoryTx itself is returned for sinks that want to inspect state.
func (t *MemoryTx) Underlying() any {
	return t
}

// Commit implements Tx.
func (t *MemoryTx) Commit() error {
	if t.closed {
		return nil
	}
	for id, rec := range t.staged {
		if t.store.hooks.OnCommit != nil {
			copy := rec
			if err := t.store.hooks.OnCommit(&copy); err != nil {
				t.release()
				return err
			}
		}
		if rec.Phase == PhaseComplete {
			t.store.history = append(t.store.history, Completion{
				PacketID:   rec.PacketID,
				Generation: rec.Generation,
			})
		}
		t.store.records[id] = rec
	}
	t.release()
	return nil
}

// Rollback implements Tx and is a no-op after Commit.
func (t *MemoryTx) Rollback() error {
	if t.closed {
		return nil
	}
	t.release()
	return nil
}

func (t *MemoryTx) release() {
	t.closed = true
	t.staged = nil
	t.store.mu.Unlock()
}
