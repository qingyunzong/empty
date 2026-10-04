// Package objstore maps opaque, random external tokens to internal object
// handles. Tokens embed the tenant, the internal ID generation, and a random
// nonce, so deleting an object permanently invalidates its token even when
// the internal ID is later reused (ABA-safe). All reads are authorized
// against a tenant context, and batch reads are all-or-nothing.
package objstore

import (
	"errors"
	"fmt"
	"math/rand"
	"sync"
)

// ErrUnauthorized is returned when a well-formed token does not match a live
// object for the requesting tenant (wrong tenant, stale generation, deleted
// object, or unknown nonce).
var ErrUnauthorized = errors.New("objstore: token not authorized")

// slot is one internal handle. IDs are recycled via a free list, but the
// generation counter is monotonic per slot, so a recycled ID never
// resurrects a token minted for a previous occupant.
type slot struct {
	generation uint64
	nonce      uint64
	tenantID   uint64
	value      any
	alive      bool
}

// Store is a tenant-aware object store. It is safe for concurrent use.
type Store struct {
	mu  sync.Mutex
	rng *rand.Rand

	tenantIDs  map[string]uint64
	nextTenant uint64

	slots []slot
	free  []uint64 // recycled slot indices, LIFO
}

// NewStore returns a Store whose randomness is drawn from rng. Pass
// rand.New(rand.NewSource(seed)) for deterministic, reproducible tokens.
func NewStore(rng *rand.Rand) *Store {
	return &Store{
		rng:        rng,
		tenantIDs:  make(map[string]uint64),
		nextTenant: 1,
	}
}

func (s *Store) tenantIDLocked(tenant string) (uint64, bool) {
	id, ok := s.tenantIDs[tenant]
	return id, ok
}

func (s *Store) registerTenantLocked(tenant string) uint64 {
	if id, ok := s.tenantIDs[tenant]; ok {
		return id
	}
	id := s.nextTenant
	s.nextTenant++
	s.tenantIDs[tenant] = id
	return id
}

// Create stores value under tenant and returns a fresh external token.
func (s *Store) Create(tenant string, value any) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	tid := s.registerTenantLocked(tenant)

	var id uint64
	if n := len(s.free); n > 0 {
		id = s.free[n-1]
		s.free = s.free[:n-1]
	} else {
		id = uint64(len(s.slots))
		s.slots = append(s.slots, slot{})
	}

	sl := &s.slots[id]
	sl.generation++ // monotonic: old tokens for this ID stay invalid
	sl.nonce = s.rng.Uint64()
	sl.tenantID = tid
	sl.value = value
	sl.alive = true

	return encodeToken(tokenPayload{
		tenantID:   tid,
		objectID:   id,
		generation: sl.generation,
		nonce:      sl.nonce,
	})
}

// resolveLocked validates a token against the requesting tenant and returns
// the live slot it refers to.
func (s *Store) resolveLocked(tenant, tok string) (*slot, error) {
	p, err := decodeToken(tok)
	if err != nil {
		return nil, err
	}
	tid, ok := s.tenantIDLocked(tenant)
	if !ok || tid != p.tenantID {
		return nil, ErrUnauthorized
	}
	if p.objectID >= uint64(len(s.slots)) {
		return nil, ErrUnauthorized
	}
	sl := &s.slots[p.objectID]
	if !sl.alive || sl.generation != p.generation || sl.nonce != p.nonce {
		return nil, ErrUnauthorized
	}
	return sl, nil
}

// Get returns the value for tok, authorized against tenant.
func (s *Store) Get(tenant, tok string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sl, err := s.resolveLocked(tenant, tok)
	if err != nil {
		return nil, err
	}
	return sl.value, nil
}

// Delete invalidates tok. The internal ID may be recycled later, but the
// bumped generation guarantees this token can never resolve again.
func (s *Store) Delete(tenant, tok string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sl, err := s.resolveLocked(tenant, tok)
	if err != nil {
		return err
	}
	p, _ := decodeToken(tok) // already validated above
	sl.alive = false
	sl.value = nil
	s.free = append(s.free, p.objectID)
	return nil
}

// BatchGet resolves every token under tenant and returns the values in
// order. If any single token is malformed or unauthorized, the whole batch
// fails and no values are returned.
func (s *Store) BatchGet(tenant string, toks []string) ([]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := make([]any, len(toks))
	for i, tok := range toks {
		sl, err := s.resolveLocked(tenant, tok)
		if err != nil {
			return nil, fmt.Errorf("objstore: batch item %d: %w", i, err)
		}
		values[i] = sl.value
	}
	return values, nil
}
