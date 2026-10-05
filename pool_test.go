package tokenpool

import (
	"errors"
	"math/rand"
	"testing"
)

func acquireN(t *testing.T, p *Pool, n int) []Token {
	t.Helper()
	tokens := make([]Token, 0, n)
	for i := 0; i < n; i++ {
		tok, err := p.Acquire()
		if err != nil {
			t.Fatalf("Acquire %d of %d failed: %v", i, n, err)
		}
		tokens = append(tokens, tok)
	}
	return tokens
}

func TestAcquireUpToCapacity(t *testing.T) {
	p := NewPool(3)
	tokens := acquireN(t, p, 3)
	seen := map[int]bool{}
	for _, tok := range tokens {
		if seen[tok.ID()] {
			t.Fatalf("duplicate token id %d issued", tok.ID())
		}
		seen[tok.ID()] = true
	}
	if _, err := p.Acquire(); !errors.Is(err, ErrExhausted) {
		t.Fatalf("expected ErrExhausted, got %v", err)
	}
	if p.Available() != 0 {
		t.Fatalf("Available = %d, want 0", p.Available())
	}
}

func TestReturnBatchSuccess(t *testing.T) {
	p := NewPool(4)
	tokens := acquireN(t, p, 4)
	if err := p.ReturnBatch(tokens[:3]); err != nil {
		t.Fatalf("ReturnBatch failed: %v", err)
	}
	if p.Issued() != 1 || p.Available() != 3 {
		t.Fatalf("Issued=%d Available=%d, want 1/3", p.Issued(), p.Available())
	}
}

func TestReturnBatchDuplicateRejectedAtomically(t *testing.T) {
	p := NewPool(3)
	tokens := acquireN(t, p, 3)
	batch := []Token{tokens[0], tokens[1], tokens[0]}
	if err := p.ReturnBatch(batch); !errors.Is(err, ErrDuplicateToken) {
		t.Fatalf("expected ErrDuplicateToken, got %v", err)
	}
	if p.Issued() != 3 {
		t.Fatalf("batch was not atomic: Issued=%d, want 3", p.Issued())
	}
}

func TestReturnBatchForeignTokenRejectedAtomically(t *testing.T) {
	p := NewPool(2)
	other := NewPool(2)
	tokens := acquireN(t, p, 2)
	foreign := acquireN(t, other, 1)[0]

	batch := []Token{tokens[0], foreign}
	if err := p.ReturnBatch(batch); !errors.Is(err, ErrForeignToken) {
		t.Fatalf("expected ErrForeignToken, got %v", err)
	}
	if p.Issued() != 2 {
		t.Fatalf("batch was not atomic: Issued=%d, want 2", p.Issued())
	}
}

func TestReturnBatchUnissuedTokenRejected(t *testing.T) {
	p := NewPool(2)
	tokens := acquireN(t, p, 2)
	if err := p.ReturnBatch(tokens); err != nil {
		t.Fatalf("first return failed: %v", err)
	}
	// Returning the same tokens again must fail: copies do not redeem twice.
	if err := p.ReturnBatch(tokens); !errors.Is(err, ErrTokenNotIssued) {
		t.Fatalf("expected ErrTokenNotIssued, got %v", err)
	}
	if p.Issued() != 0 {
		t.Fatalf("Issued=%d, want 0", p.Issued())
	}
}

func TestReturnBatchEmptyRejected(t *testing.T) {
	p := NewPool(1)
	if err := p.ReturnBatch(nil); !errors.Is(err, ErrEmptyBatch) {
		t.Fatalf("expected ErrEmptyBatch, got %v", err)
	}
}

func TestResetInvalidatesOldTokens(t *testing.T) {
	p := NewPool(3)
	old := acquireN(t, p, 3)
	gen := p.Generation()
	p.Reset()
	if p.Generation() == gen {
		t.Fatal("Reset did not advance generation")
	}
	if p.Available() != 3 {
		t.Fatalf("Available=%d after reset, want 3", p.Available())
	}
	// Old tokens must not affect the new pool.
	fresh := acquireN(t, p, 2)
	batch := append([]Token{old[0], old[1]}, fresh...)
	if err := p.ReturnBatch(batch); !errors.Is(err, ErrForeignToken) {
		t.Fatalf("expected ErrForeignToken, got %v", err)
	}
	if p.Issued() != 2 {
		t.Fatalf("stale tokens affected new pool: Issued=%d, want 2", p.Issued())
	}
}

// TestRandomModel cross-checks the pool against a simple set model under
// random acquires, batch returns (valid and deliberately corrupted), and
// resets. After every operation the pool's capacity accounting must match
// the model exactly.
func TestRandomModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const capacity = 16
	p := NewPool(capacity)

	// model holds the tokens the model believes are outstanding.
	model := map[Token]bool{}
	// stale holds tokens invalidated by resets; they must never be accepted.
	var stale []Token

	check := func(step int) {
		t.Helper()
		if p.Issued() != len(model) {
			t.Fatalf("step %d: Issued=%d, model=%d", step, p.Issued(), len(model))
		}
		if p.Available() != capacity-len(model) {
			t.Fatalf("step %d: Available=%d, want %d", step, p.Available(), capacity-len(model))
		}
	}

	outstanding := func() []Token {
		list := make([]Token, 0, len(model))
		for tok := range model {
			list = append(list, tok)
		}
		return list
	}

	for step := 0; step < 5000; step++ {
		switch rng.Intn(5) {
		case 0, 1: // acquire
			tok, err := p.Acquire()
			if len(model) < capacity {
				if err != nil {
					t.Fatalf("step %d: unexpected acquire failure: %v", step, err)
				}
				if model[tok] {
					t.Fatalf("step %d: reissued live token %+v", step, tok)
				}
				model[tok] = true
			} else if !errors.Is(err, ErrExhausted) {
				t.Fatalf("step %d: expected ErrExhausted, got %v", step, err)
			}

		case 2, 3: // batch return, sometimes corrupted
			live := outstanding()
			rng.Shuffle(len(live), func(i, j int) { live[i], live[j] = live[j], live[i] })
			n := rng.Intn(len(live) + 1)
			batch := append([]Token(nil), live[:n]...)
			corrupt := rng.Intn(4) == 0 && (len(batch) > 0 || len(stale) > 0)
			if corrupt {
				choice := rng.Intn(3)
				if len(batch) == 0 {
					choice = 1 // empty batch: only a stale token can corrupt it
				}
				switch choice {
				case 0: // duplicate within batch
					batch = append(batch, batch[rng.Intn(len(batch))])
				case 1: // stale token from an older generation
					batch = append(batch, stale[rng.Intn(len(stale))])
				case 2: // fabricated token, never issued
					batch = append(batch, Token{id: capacity + 1000 + rng.Intn(1000), generation: p.Generation()})
				}
			}
			err := p.ReturnBatch(batch)
			switch {
			case len(batch) == 0:
				if !errors.Is(err, ErrEmptyBatch) {
					t.Fatalf("step %d: expected ErrEmptyBatch, got %v", step, err)
				}
			case corrupt:
				if err == nil {
					t.Fatalf("step %d: corrupted batch accepted", step)
				}
				// Atomicity: nothing may have been returned.
				if p.Issued() != len(model) {
					t.Fatalf("step %d: rejected batch changed state", step)
				}
			default:
				if err != nil {
					t.Fatalf("step %d: valid batch rejected: %v", step, err)
				}
				for _, tok := range batch {
					delete(model, tok)
				}
			}

		case 4: // reset
			for tok := range model {
				stale = append(stale, tok)
			}
			model = map[Token]bool{}
			p.Reset()
		}
		check(step)
	}
}
