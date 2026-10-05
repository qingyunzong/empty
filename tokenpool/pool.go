// Package tokenpool implements a resource pool that hands out
// non-copyable numbered tokens and validates batch returns atomically.
package tokenpool

import (
	"errors"
	"fmt"
	"sync"
)

// noCopy may be added to structs which must not be copied after first use.
// `go vet` reports copies of values containing it.
type noCopy struct{}

func (*noCopy) Lock()   {}
func (*noCopy) Unlock() {}

// Token is a non-copyable, uniquely numbered lease on one unit of pool
// capacity. Tokens are always used through *Token; the zero value is
// invalid and a Token must never be copied after being issued.
type Token struct {
	noCopy noCopy

	pool *Pool
	id   uint64
	gen  uint64
}

// ID returns the token's unique number within its generation.
func (t *Token) ID() uint64 { return t.id }

// Generation returns the pool generation the token was issued in.
func (t *Token) Generation() uint64 { return t.gen }

// Pool is a fixed-capacity resource pool. The zero value is not usable;
// construct one with New.
type Pool struct {
	mu         sync.Mutex
	capacity   int
	gen        uint64
	nextID     uint64
	checkedOut map[uint64]struct{}
}

// ErrInvalidToken is returned (wrapped) when a batch contains a token that
// is nil, foreign, stale-generation, duplicated, or not checked out.
var ErrInvalidToken = errors.New("tokenpool: invalid token in batch")

// New creates a pool that can have at most capacity tokens checked out.
func New(capacity int) *Pool {
	if capacity < 0 {
		panic("tokenpool: negative capacity")
	}
	return &Pool{
		capacity:   capacity,
		checkedOut: make(map[uint64]struct{}),
	}
}

// Capacity returns the maximum number of tokens that may be checked out.
func (p *Pool) Capacity() int { return p.capacity }

// Generation returns the current pool generation.
func (p *Pool) Generation() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gen
}

// CheckedOut returns how many tokens are currently checked out.
func (p *Pool) CheckedOut() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.checkedOut)
}

// Available returns how many more tokens can be acquired.
func (p *Pool) Available() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.capacity - len(p.checkedOut)
}

// Acquire checks out a fresh token, or returns (nil, false) when the pool
// is exhausted.
func (p *Pool) Acquire() (*Token, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.checkedOut) >= p.capacity {
		return nil, false
	}
	id := p.nextID
	p.nextID++
	p.checkedOut[id] = struct{}{}
	return &Token{pool: p, id: id, gen: p.gen}, true
}

// validLocked reports whether t is a live token of this pool's current
// generation. The caller must hold p.mu.
func (p *Pool) validLocked(t *Token) bool {
	if t == nil || t.pool != p || t.gen != p.gen {
		return false
	}
	_, ok := p.checkedOut[t.id]
	return ok
}

// ReturnBatch returns a whole batch of tokens to the pool atomically.
// The batch is first validated in full: every token must be non-nil,
// belong to this pool, belong to the current generation, be currently
// checked out, and appear at most once in the batch. If any token fails
// validation the entire batch is rejected and no token is returned.
func (p *Pool) ReturnBatch(tokens ...*Token) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	seen := make(map[uint64]struct{}, len(tokens))
	for i, t := range tokens {
		if !p.validLocked(t) {
			return fmt.Errorf("%w (index %d)", ErrInvalidToken, i)
		}
		if _, dup := seen[t.id]; dup {
			return fmt.Errorf("%w: duplicate token %d (index %d)", ErrInvalidToken, t.id, i)
		}
		seen[t.id] = struct{}{}
	}
	for id := range seen {
		delete(p.checkedOut, id)
	}
	return nil
}

// Reset returns every checked-out token to the pool and advances the
// generation, permanently invalidating all previously issued tokens so
// they can never affect the new pool state.
func (p *Pool) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gen++
	p.nextID = 0
	p.checkedOut = make(map[uint64]struct{})
}
