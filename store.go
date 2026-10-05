// Package objstore implements an object API library that maps internal
// handles to random external tokens. Tokens embed the owning tenant and a
// generation counter so that deleted handles stay dead even when the
// internal ID is later reused (ABA protection).
package objstore

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"sync"
)

var (
	// ErrInvalidToken is returned when a token is malformed, unknown, or
	// refers to a stale generation of a handle.
	ErrInvalidToken = errors.New("objstore: invalid token")
	// ErrUnauthorized is returned when a valid token is presented by a
	// tenant that does not own the object.
	ErrUnauthorized = errors.New("objstore: token not authorized for tenant")
)

// Token is the opaque external identifier of an object.
type Token string

// Info describes the non-secret payload embedded in a Token.
type Info struct {
	Tenant     string
	Generation uint64
	Handle     int
}

// Object is a stored value together with its current external token.
type Object struct {
	Token Token
	Data  []byte
}

type slot struct {
	tenant     string
	generation uint64
	data       []byte
	alive      bool
}

// Store maps internal integer handles to random external tokens. The zero
// value is not usable; construct one with NewStore or NewStoreWithSeed.
type Store struct {
	mu    sync.Mutex
	rng   *rand.Rand
	slots []slot
	free  []int // LIFO stack of reusable handles
	byTok map[Token]int
}

// NewStore returns a Store that draws token randomness from rng. The caller
// controls the generator, so tests can seed it deterministically.
func NewStore(rng *rand.Rand) *Store {
	return &Store{
		rng:   rng,
		byTok: make(map[Token]int),
	}
}

// NewStoreWithSeed is a convenience wrapper around NewStore using a
// freshly seeded pseudo-random generator.
func NewStoreWithSeed(seed int64) *Store {
	return NewStore(rand.New(rand.NewSource(seed)))
}

// Create stores data for tenant and returns its external token.
func (s *Store) Create(tenant string, data []byte) Token {
	s.mu.Lock()
	defer s.mu.Unlock()

	var handle int
	if n := len(s.free); n > 0 {
		handle = s.free[n-1]
		s.free = s.free[:n-1]
	} else {
		handle = len(s.slots)
		s.slots = append(s.slots, slot{})
	}

	sl := &s.slots[handle]
	sl.tenant = tenant
	sl.generation++ // bump on every (re)use so stale tokens never match
	sl.data = append([]byte(nil), data...)
	sl.alive = true

	tok := s.mintLocked(tenant, sl.generation, handle)
	s.byTok[tok] = handle
	return tok
}

// Get returns the object identified by tok, if tenant is authorized.
func (s *Store) Get(tenant string, tok Token) (Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	handle, err := s.lookupLocked(tenant, tok)
	if err != nil {
		return Object{}, err
	}
	sl := &s.slots[handle]
	return Object{Token: tok, Data: append([]byte(nil), sl.data...)}, nil
}

// GetBatch reads many objects atomically: if any token is invalid or not
// authorized for tenant, the whole batch fails and nothing is returned.
func (s *Store) GetBatch(tenant string, toks []Token) ([]Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	handles := make([]int, len(toks))
	for i, tok := range toks {
		handle, err := s.lookupLocked(tenant, tok)
		if err != nil {
			return nil, fmt.Errorf("objstore: batch item %d: %w", i, err)
		}
		handles[i] = handle
	}

	objs := make([]Object, len(toks))
	for i, handle := range handles {
		objs[i] = Object{
			Token: toks[i],
			Data:  append([]byte(nil), s.slots[handle].data...),
		}
	}
	return objs, nil
}

// Delete invalidates tok. The internal handle becomes reusable, but its
// generation is bumped on reuse, so the deleted token stays dead forever.
func (s *Store) Delete(tenant string, tok Token) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	handle, err := s.lookupLocked(tenant, tok)
	if err != nil {
		return err
	}
	sl := &s.slots[handle]
	sl.alive = false
	sl.data = nil
	delete(s.byTok, tok)
	s.free = append(s.free, handle)
	return nil
}

// Parse decodes the tenant and generation embedded in a token without
// consulting the store. It does not validate the token.
func Parse(tok Token) (Info, error) {
	parts := strings.Split(string(tok), ".")
	if len(parts) != 5 || parts[0] != "v1" {
		return Info{}, ErrInvalidToken
	}
	tenant, err := hex.DecodeString(parts[1])
	if err != nil {
		return Info{}, ErrInvalidToken
	}
	gen, err := strconv.ParseUint(parts[2], 16, 64)
	if err != nil {
		return Info{}, ErrInvalidToken
	}
	handle, err := strconv.ParseUint(parts[3], 16, 64)
	if err != nil {
		return Info{}, ErrInvalidToken
	}
	if _, err := strconv.ParseUint(parts[4], 16, 64); err != nil {
		return Info{}, ErrInvalidToken
	}
	return Info{Tenant: string(tenant), Generation: gen, Handle: int(handle)}, nil
}

// lookupLocked resolves tok to a live handle and enforces tenancy.
func (s *Store) lookupLocked(tenant string, tok Token) (int, error) {
	info, err := Parse(tok)
	if err != nil {
		return 0, err
	}
	handle, ok := s.byTok[tok]
	if !ok {
		return 0, ErrInvalidToken
	}
	sl := &s.slots[handle]
	if !sl.alive || sl.generation != info.Generation ||
		sl.tenant != info.Tenant || info.Handle != handle {
		return 0, ErrInvalidToken
	}
	if sl.tenant != tenant {
		return 0, ErrUnauthorized
	}
	return handle, nil
}

// mintLocked builds a token of the form
// v1.<hex tenant>.<hex generation>.<hex handle>.<hex nonce>.
func (s *Store) mintLocked(tenant string, generation uint64, handle int) Token {
	nonce := s.rng.Uint64()
	return Token(fmt.Sprintf("v1.%x.%x.%x.%x",
		[]byte(tenant), generation, uint64(handle), nonce))
}
