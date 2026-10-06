package evidence

import (
	"sync"
	"time"
)

// TrustStore records, per signer, the moment each trust version was revoked.
// A zero/absent entry means the trust version is still good.
type TrustStore struct {
	mu      sync.RWMutex
	revoked map[string]map[int]time.Time
}

func NewTrustStore() *TrustStore {
	return &TrustStore{revoked: make(map[string]map[int]time.Time)}
}

// Revoke marks a signer's trust version as revoked at the given moment.
func (s *TrustStore) Revoke(signer string, version int, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.revoked[signer] == nil {
		s.revoked[signer] = make(map[int]time.Time)
	}
	s.revoked[signer][version] = at
}

// RevokedAt reports whether the signer's trust version is revoked and, if
// so, the revocation moment.
func (s *TrustStore) RevokedAt(signer string, version int) (time.Time, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	at, ok := s.revoked[signer][version]
	return at, ok
}
