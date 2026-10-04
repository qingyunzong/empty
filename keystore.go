package sigverify

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrUnknownKey is returned when a key ID is not present in the store.
var ErrUnknownKey = errors.New("sigverify: unknown key ID")

// Key is a signing key valid over the half-open interval
// [NotBefore, NotAfter): a time t is inside the window iff
// NotBefore <= t < NotAfter. Revocation, when set, shortens the window.
type Key struct {
	ID        string
	Material  []byte
	NotBefore time.Time
	NotAfter  time.Time // exclusive
	RevokedAt *time.Time
}

// ValidAt reports whether the key may be used at time t.
func (k *Key) ValidAt(t time.Time) bool {
	if t.Before(k.NotBefore) || !t.Before(k.NotAfter) {
		return false
	}
	if k.RevokedAt != nil && !t.Before(*k.RevokedAt) {
		return false
	}
	return true
}

// KeyStore is a concurrency-safe registry of keys by ID.
type KeyStore struct {
	mu   sync.RWMutex
	keys map[string]*Key
}

// NewKeyStore returns an empty store.
func NewKeyStore() *KeyStore {
	return &KeyStore{keys: make(map[string]*Key)}
}

// Add registers k. Keys with different IDs may have overlapping validity
// windows; overlap is the explicit mechanism that makes rotation graceful.
// Adding a duplicate ID or an empty/inverted window is rejected.
func (s *KeyStore) Add(k Key) error {
	if k.ID == "" {
		return errors.New("sigverify: key ID must not be empty")
	}
	if !k.NotAfter.After(k.NotBefore) {
		return fmt.Errorf("sigverify: key %q has empty validity window", k.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.keys[k.ID]; exists {
		return fmt.Errorf("sigverify: key %q already registered", k.ID)
	}
	key := k
	s.keys[k.ID] = &key
	return nil
}

// Rotate registers successor so that its validity begins overlap before
// the predecessor's NotAfter. The overlap window is explicit: during it,
// both keys verify, allowing signers and verifiers to migrate safely.
// successor.NotBefore is derived; successor.NotAfter must be supplied.
func (s *KeyStore) Rotate(predecessorID string, successor Key, overlap time.Duration) error {
	if overlap < 0 {
		return errors.New("sigverify: overlap must not be negative")
	}
	s.mu.RLock()
	pred, ok := s.keys[predecessorID]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("sigverify: rotate: %w: %q", ErrUnknownKey, predecessorID)
	}
	successor.NotBefore = pred.NotAfter.Add(-overlap)
	return s.Add(successor)
}

// Revoke marks the key as revoked at time at. Revocation takes effect
// immediately: the key is invalid for any t >= at, including for
// requests received after at even if they were signed before it.
func (s *KeyStore) Revoke(id string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	k, ok := s.keys[id]
	if !ok {
		return fmt.Errorf("sigverify: revoke: %w: %q", ErrUnknownKey, id)
	}
	atCopy := at
	k.RevokedAt = &atCopy
	return nil
}

// Lookup returns the key for id, or false if none is registered.
func (s *KeyStore) Lookup(id string) (*Key, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	k, ok := s.keys[id]
	return k, ok
}
