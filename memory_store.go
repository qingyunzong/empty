package q245

import (
	"context"
	"sync"
	"time"
)

// Clock abstracts time acquisition so callers (and tests) can control
// tolerance and expiry behavior deterministically.
type Clock interface {
	Now() time.Time
}

// systemClock is the default Clock, backed by time.Now.
type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// MemoryTenantKeyStore is an in-memory TenantKeyStore, suitable for
// tests and single-process deployments.
type MemoryTenantKeyStore struct {
	mu      sync.RWMutex
	secrets map[string][]byte
}

// NewMemoryTenantKeyStore creates a key store seeded with tenantSecrets.
// The map is copied; later mutations must go through SetSecret.
func NewMemoryTenantKeyStore(tenantSecrets map[string][]byte) *MemoryTenantKeyStore {
	secrets := make(map[string][]byte, len(tenantSecrets))
	for tenant, secret := range tenantSecrets {
		secrets[tenant] = append([]byte(nil), secret...)
	}
	return &MemoryTenantKeyStore{secrets: secrets}
}

// SetSecret registers or replaces the secret for tenant.
func (s *MemoryTenantKeyStore) SetSecret(tenant string, secret []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.secrets[tenant] = append([]byte(nil), secret...)
}

// Secret implements TenantKeyStore.
func (s *MemoryTenantKeyStore) Secret(_ context.Context, tenant string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	secret, ok := s.secrets[tenant]
	if !ok {
		return nil, ErrUnknownTenant
	}
	return append([]byte(nil), secret...), nil
}

var _ TenantKeyStore = (*MemoryTenantKeyStore)(nil)

// memoryTx is the Tx implementation used by MemoryTransactionManager.
type memoryTx struct {
	ctx context.Context
}

func (tx *memoryTx) Context() context.Context { return tx.ctx }

var _ Tx = (*memoryTx)(nil)

// nonceEntry records one occupied nonce.
type nonceEntry struct {
	expiresAt time.Time
}

// MemoryTransactionManager is an in-memory TransactionManager.
//
// It models a unique index on (tenantID, nonce): occupation, handler
// execution and "commit" are serialized per tenant, a live duplicate is
// rejected with ErrDuplicateNonce, and rollback removes the tentative
// entry so the same nonce can be retried. Expired entries are reclaimed
// lazily on access and eagerly via ReapExpired.
type MemoryTransactionManager struct {
	clock Clock

	mu      sync.Mutex
	entries map[string]map[string]nonceEntry

	committed  int
	rolledBack int
	duplicates int
	reaped     int
}

// NewMemoryTransactionManager creates an in-memory transaction manager.
// A nil clock means the wall clock is used.
func NewMemoryTransactionManager(clock Clock) *MemoryTransactionManager {
	if clock == nil {
		clock = systemClock{}
	}
	return &MemoryTransactionManager{
		clock:   clock,
		entries: make(map[string]map[string]nonceEntry),
	}
}

// WithinTx implements TransactionManager.
func (m *MemoryTransactionManager) WithinTx(ctx context.Context, tenantID, nonce string, expiresAt time.Time, fn func(Tx) error) error {
	if err := m.occupy(tenantID, nonce, expiresAt); err != nil {
		return err
	}
	tx := &memoryTx{ctx: ctx}
	if err := fn(tx); err != nil {
		m.rollback(tenantID, nonce)
		return err
	}
	m.commit(tenantID, nonce)
	return nil
}

// occupy claims (tenantID, nonce), lazily evicting expired entries first.
func (m *MemoryTransactionManager) occupy(tenantID, nonce string, expiresAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	tenantEntries := m.entries[tenantID]
	if tenantEntries == nil {
		tenantEntries = make(map[string]nonceEntry)
		m.entries[tenantID] = tenantEntries
	}

	now := m.clock.Now()
	if entry, ok := tenantEntries[nonce]; ok {
		if now.Before(entry.expiresAt) {
			m.duplicates++
			return ErrDuplicateNonce
		}
		delete(tenantEntries, nonce)
		m.reaped++
	}
	tenantEntries[nonce] = nonceEntry{expiresAt: expiresAt}
	return nil
}

func (m *MemoryTransactionManager) commit(tenantID, nonce string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.committed++
	// The tentative entry stays in place until it expires; that is what
	// blocks replay and concurrent duplicates.
}

func (m *MemoryTransactionManager) rollback(tenantID, nonce string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if tenantEntries, ok := m.entries[tenantID]; ok {
		delete(tenantEntries, nonce)
	}
	m.rolledBack++
}

// ReapExpired removes every nonce whose expiry has been reached and
// returns the number of reclaimed entries. An entry expiring exactly at
// the current time is considered expired.
func (m *MemoryTransactionManager) ReapExpired() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.clock.Now()
	reaped := 0
	for tenantID, tenantEntries := range m.entries {
		for nonce, entry := range tenantEntries {
			if !now.Before(entry.expiresAt) {
				delete(tenantEntries, nonce)
				m.reaped++
				reaped++
			}
		}
		if len(tenantEntries) == 0 {
			delete(m.entries, tenantID)
		}
	}
	return reaped
}

// Committed returns the number of transactions that committed.
func (m *MemoryTransactionManager) Committed() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.committed
}

// RolledBack returns the number of handler-driven rollbacks.
func (m *MemoryTransactionManager) RolledBack() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rolledBack
}

// Duplicates returns the number of attempts rejected as live duplicates.
func (m *MemoryTransactionManager) Duplicates() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.duplicates
}

// Reaped returns the total number of expired entries reclaimed, both
// lazy and explicit.
func (m *MemoryTransactionManager) Reaped() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reaped
}

var _ TransactionManager = (*MemoryTransactionManager)(nil)
