package tokenpool

import (
	"errors"
	"math/rand"
	"testing"
)

func TestAcquireUpToCapacity(t *testing.T) {
	p := New(3)
	var toks []*Token
	for i := 0; i < 3; i++ {
		tok, ok := p.Acquire()
		if !ok {
			t.Fatalf("acquire %d failed before capacity reached", i)
		}
		toks = append(toks, tok)
	}
	if tok, ok := p.Acquire(); ok || tok != nil {
		t.Fatalf("acquire beyond capacity succeeded: tok=%v ok=%v", tok, ok)
	}
	if got := p.CheckedOut(); got != 3 {
		t.Fatalf("CheckedOut = %d, want 3", got)
	}
	if got := p.Available(); got != 0 {
		t.Fatalf("Available = %d, want 0", got)
	}
	if err := p.ReturnBatch(toks...); err != nil {
		t.Fatalf("ReturnBatch: %v", err)
	}
	if got := p.Available(); got != 3 {
		t.Fatalf("Available after return = %d, want 3", got)
	}
}

func TestTokenIDsUnique(t *testing.T) {
	p := New(100)
	seen := map[uint64]bool{}
	for i := 0; i < 100; i++ {
		tok, ok := p.Acquire()
		if !ok {
			t.Fatalf("acquire %d failed", i)
		}
		if seen[tok.ID()] {
			t.Fatalf("duplicate token ID %d", tok.ID())
		}
		seen[tok.ID()] = true
	}
}

func TestBatchReturnRejectsDuplicate(t *testing.T) {
	p := New(4)
	a, _ := p.Acquire()
	b, _ := p.Acquire()
	err := p.ReturnBatch(a, b, a)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken", err)
	}
	if got := p.CheckedOut(); got != 2 {
		t.Fatalf("CheckedOut = %d after rejected batch, want 2 (atomic reject)", got)
	}
}

func TestBatchReturnRejectsForeignToken(t *testing.T) {
	p1, p2 := New(2), New(2)
	a, _ := p1.Acquire()
	foreign, _ := p2.Acquire()
	err := p1.ReturnBatch(a, foreign)
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken", err)
	}
	if got := p1.CheckedOut(); got != 1 {
		t.Fatalf("p1 CheckedOut = %d, want 1", got)
	}
	if got := p2.CheckedOut(); got != 1 {
		t.Fatalf("p2 CheckedOut = %d, want 1", got)
	}
}

func TestBatchReturnRejectsNilAndDoubleReturn(t *testing.T) {
	p := New(2)
	a, _ := p.Acquire()
	if err := p.ReturnBatch(a, nil); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("nil token: err = %v, want ErrInvalidToken", err)
	}
	if err := p.ReturnBatch(a); err != nil {
		t.Fatalf("first return: %v", err)
	}
	if err := p.ReturnBatch(a); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("double return: err = %v, want ErrInvalidToken", err)
	}
}

func TestResetInvalidatesOldTokens(t *testing.T) {
	p := New(3)
	old, _ := p.Acquire()
	gen0 := p.Generation()
	p.Reset()
	if p.Generation() == gen0 {
		t.Fatal("generation did not change after Reset")
	}
	if got := p.CheckedOut(); got != 0 {
		t.Fatalf("CheckedOut = %d after reset, want 0", got)
	}
	if err := p.ReturnBatch(old); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("returning stale token: err = %v, want ErrInvalidToken", err)
	}
	// Old token must not free capacity in the new generation.
	for i := 0; i < 3; i++ {
		if _, ok := p.Acquire(); !ok {
			t.Fatalf("acquire %d after reset failed; stale token corrupted pool", i)
		}
	}
	if _, ok := p.Acquire(); ok {
		t.Fatal("pool over capacity after reset")
	}
}

// TestRandomizedAgainstModel drives the pool with random acquires, batch
// returns (including deliberately corrupted batches) and resets, checking
// every step against a simple set model and the capacity invariant.
func TestRandomizedAgainstModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const capacity = 8
	p := New(capacity)
	other := New(capacity) // source of foreign tokens

	// model: tokens the test believes are checked out of p.
	model := map[*Token]bool{}
	// graveyard: tokens already returned or invalidated, for corruption.
	var graveyard []*Token

	check := func(step int) {
		t.Helper()
		if got := p.CheckedOut(); got != len(model) {
			t.Fatalf("step %d: CheckedOut = %d, model = %d", step, got, len(model))
		}
		if p.CheckedOut() > capacity {
			t.Fatalf("step %d: capacity exceeded: %d > %d", step, p.CheckedOut(), capacity)
		}
		if p.Available() != capacity-len(model) {
			t.Fatalf("step %d: Available = %d, want %d", step, p.Available(), capacity-len(model))
		}
	}

	for step := 0; step < 20000; step++ {
		switch rng.Intn(10) {
		case 0, 1, 2, 3: // acquire
			tok, ok := p.Acquire()
			if len(model) == capacity {
				if ok {
					t.Fatalf("step %d: acquire succeeded at full capacity", step)
				}
			} else {
				if !ok {
					t.Fatalf("step %d: acquire failed with %d/%d checked out", step, len(model), capacity)
				}
				model[tok] = true
			}

		case 4, 5, 6, 7: // batch return, sometimes corrupted
			var batch []*Token
			for tok := range model {
				if rng.Intn(2) == 0 {
					batch = append(batch, tok)
				}
			}
			corrupt := len(batch) > 0 && rng.Intn(3) == 0
			if corrupt {
				switch rng.Intn(4) {
				case 0: // duplicate
					batch = append(batch, batch[rng.Intn(len(batch))])
				case 1: // foreign token
					f, _ := other.Acquire()
					batch = append(batch, f)
				case 2: // stale / already-returned token
					if len(graveyard) > 0 {
						batch = append(batch, graveyard[rng.Intn(len(graveyard))])
					} else {
						corrupt = false
					}
				case 3: // nil
					batch = append(batch, nil)
				}
			}
			err := p.ReturnBatch(batch...)
			if corrupt {
				if !errors.Is(err, ErrInvalidToken) {
					t.Fatalf("step %d: corrupted batch accepted: err=%v", step, err)
				}
			} else {
				if err != nil {
					t.Fatalf("step %d: clean batch rejected: %v", step, err)
				}
				for _, tok := range batch {
					delete(model, tok)
					graveyard = append(graveyard, tok)
				}
			}

		case 8: // reset
			for tok := range model {
				graveyard = append(graveyard, tok)
			}
			model = map[*Token]bool{}
			p.Reset()

		case 9: // return a stale token from the graveyard; must never succeed
			if len(graveyard) > 0 {
				stale := graveyard[rng.Intn(len(graveyard))]
				if err := p.ReturnBatch(stale); !errors.Is(err, ErrInvalidToken) {
					t.Fatalf("step %d: stale token accepted: %v", step, err)
				}
			}
		}
		check(step)
	}
}
