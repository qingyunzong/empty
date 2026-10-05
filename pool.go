// Package tokenpool implements a resource pool that hands out unique,
// non-copyable numbered tokens. Tokens are bound to the pool generation
// that issued them; resetting the pool starts a new generation and
// invalidates every outstanding token from earlier generations.
package tokenpool

import (
	"errors"
	"sync/atomic"
)

var (
	ErrExhausted      = errors.New("tokenpool: no tokens available")
	ErrEmptyBatch     = errors.New("tokenpool: empty return batch")
	ErrDuplicateToken = errors.New("tokenpool: duplicate token in batch")
	ErrForeignToken   = errors.New("tokenpool: token does not belong to this pool generation")
	ErrTokenNotIssued = errors.New("tokenpool: token is not currently issued")
)

// Token is a numbered lease on one unit of pool capacity. A Token is only
// meaningful to the pool that issued it and only while its generation is
// current; it cannot be redeemed twice, so copying the value does not
// create extra capacity.
type Token struct {
	owner      uint64
	id         int
	generation uint64
}

// ID returns the token's number within its generation.
func (t Token) ID() int { return t.id }

// Generation returns the pool generation that issued the token.
func (t Token) Generation() uint64 { return t.generation }

// Pool issues numbered tokens up to a fixed capacity.
type Pool struct {
	owner      uint64
	capacity   int
	generation uint64
	issued     map[int]bool
	nextID     int
}

var nextOwnerID atomic.Uint64

// NewPool creates a pool that can have at most capacity tokens issued
// at any time.
func NewPool(capacity int) *Pool {
	if capacity < 0 {
		capacity = 0
	}
	return &Pool{
		owner:    nextOwnerID.Add(1),
		capacity: capacity,
		issued:   make(map[int]bool),
	}
}

// Capacity returns the maximum number of concurrently issued tokens.
func (p *Pool) Capacity() int { return p.capacity }

// Issued returns the number of tokens currently outstanding.
func (p *Pool) Issued() int { return len(p.issued) }

// Available returns the remaining capacity.
func (p *Pool) Available() int { return p.capacity - len(p.issued) }

// Generation returns the pool's current generation.
func (p *Pool) Generation() uint64 { return p.generation }

// Acquire issues a new token, or reports ErrExhausted when the pool is
// at capacity.
func (p *Pool) Acquire() (Token, error) {
	if len(p.issued) >= p.capacity {
		return Token{}, ErrExhausted
	}
	for p.issued[p.nextID] {
		p.nextID++
	}
	t := Token{owner: p.owner, id: p.nextID, generation: p.generation}
	p.issued[p.nextID] = true
	p.nextID++
	return t, nil
}

// ReturnBatch returns a batch of tokens to the pool atomically. The whole
// batch is validated first: every token must be distinct within the batch,
// belong to the pool's current generation, and currently be issued. If any
// token fails validation, no token in the batch is returned.
func (p *Pool) ReturnBatch(tokens []Token) error {
	if len(tokens) == 0 {
		return ErrEmptyBatch
	}
	seen := make(map[int]bool, len(tokens))
	for _, t := range tokens {
		if t.owner != p.owner || t.generation != p.generation {
			return ErrForeignToken
		}
		if seen[t.id] {
			return ErrDuplicateToken
		}
		seen[t.id] = true
		if !p.issued[t.id] {
			return ErrTokenNotIssued
		}
	}
	for _, t := range tokens {
		delete(p.issued, t.id)
	}
	return nil
}

// Reset releases every outstanding token and advances the generation, so
// tokens issued before the reset can never be returned to the new pool.
func (p *Pool) Reset() {
	p.generation++
	p.issued = make(map[int]bool)
	p.nextID = 0
}
