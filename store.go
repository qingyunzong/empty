package dataeng

import (
	"context"
	"sync"
	"time"
)

// SessionStore persists session manifests. Update must apply fn atomically:
// either fn's mutations are committed as a whole, or fn returns an error and
// nothing changes. Implementations backed by a database should use
// conditional writes on Session.Version to preserve this guarantee across
// processes.
type SessionStore interface {
	Create(ctx context.Context, s *Session) error
	Get(ctx context.Context, id string) (*Session, error)
	Update(ctx context.Context, id string, fn func(*Session) error) error
}

// MemoryStore is an in-memory SessionStore, safe for concurrent use.
type MemoryStore struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{sessions: make(map[string]*Session)}
}

// Create stores a new session, failing if the ID already exists.
func (m *MemoryStore) Create(_ context.Context, s *Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sessions[s.ID]; ok {
		return ErrSessionExists
	}
	m.sessions[s.ID] = s.Clone()
	return nil
}

// Get returns a copy of the session with the given ID.
func (m *MemoryStore) Get(_ context.Context, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return s.Clone(), nil
}

// Update atomically applies fn to the session and commits the result.
func (m *MemoryStore) Update(_ context.Context, id string, fn func(*Session) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return ErrSessionNotFound
	}
	next := s.Clone()
	if err := fn(next); err != nil {
		return err
	}
	next.Version = s.Version + 1
	next.UpdatedAt = time.Now().UTC()
	m.sessions[id] = next
	return nil
}
