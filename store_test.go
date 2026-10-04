package objstore

import (
	"errors"
	"math/rand"
	"testing"
)

func newSeededStore(seed int64) *Store {
	return NewStore(rand.New(rand.NewSource(seed)))
}

func TestControllablePRNGDeterministic(t *testing.T) {
	a := newSeededStore(42)
	b := newSeededStore(42)
	ta1 := a.Create("acme", 1)
	tb1 := b.Create("acme", 1)
	ta2 := a.Create("acme", 2)
	tb2 := b.Create("acme", 2)
	if ta1 != tb1 || ta2 != tb2 {
		t.Fatalf("same seed must reproduce tokens: %q/%q vs %q/%q", ta1, tb1, ta2, tb2)
	}
	if ta1 == ta2 {
		t.Fatal("distinct objects must get distinct tokens")
	}
}

func TestTokenEmbedsTenantAndGeneration(t *testing.T) {
	s := newSeededStore(1)
	tok := s.Create("acme", "v")
	p, err := decodeToken(tok)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.tenantID != s.tenantIDs["acme"] {
		t.Fatalf("token tenant %d, want %d", p.tenantID, s.tenantIDs["acme"])
	}
	if p.generation != 1 {
		t.Fatalf("first generation = %d, want 1", p.generation)
	}
}

func TestGetAndDelete(t *testing.T) {
	s := newSeededStore(7)
	tok := s.Create("acme", "hello")
	v, err := s.Get("acme", tok)
	if err != nil || v != "hello" {
		t.Fatalf("Get = %v, %v", v, err)
	}
	if err := s.Delete("acme", tok); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get("acme", tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Get after Delete = %v, want ErrUnauthorized", err)
	}
	if err := s.Delete("acme", tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("double Delete = %v, want ErrUnauthorized", err)
	}
}

func TestCrossTenantRejected(t *testing.T) {
	s := newSeededStore(3)
	tok := s.Create("alice", "secret")
	if _, err := s.Get("bob", tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cross-tenant Get = %v, want ErrUnauthorized", err)
	}
	if err := s.Delete("bob", tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cross-tenant Delete = %v, want ErrUnauthorized", err)
	}
	// Forged token: valid encoding, but tenant field swapped to bob's ID.
	p, _ := decodeToken(tok)
	forged := encodeToken(tokenPayload{tenantID: s.tenantIDs["bob"], objectID: p.objectID, generation: p.generation, nonce: p.nonce})
	if _, err := s.Get("bob", forged); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("forged-tenant Get = %v, want ErrUnauthorized", err)
	}
	// Original token still works for its owner.
	if _, err := s.Get("alice", tok); err != nil {
		t.Fatalf("owner Get after attacks: %v", err)
	}
}

func TestABAIDReuseDoesNotResurrect(t *testing.T) {
	s := newSeededStore(9)
	old := s.Create("acme", "old")
	pOld, _ := decodeToken(old)

	if err := s.Delete("acme", old); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// Recreate: the freed internal ID is recycled (LIFO free list).
	reborn := s.Create("acme", "new")
	pNew, _ := decodeToken(reborn)
	if pNew.objectID != pOld.objectID {
		t.Fatalf("expected ID reuse: old id %d, new id %d", pOld.objectID, pNew.objectID)
	}
	if pNew.generation <= pOld.generation {
		t.Fatalf("generation must advance: old %d, new %d", pOld.generation, pNew.generation)
	}
	if old == reborn {
		t.Fatal("reused ID must not reproduce the old token")
	}
	// The stale token stays dead; the new token is the only live one.
	if _, err := s.Get("acme", old); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("stale token Get = %v, want ErrUnauthorized", err)
	}
	if v, err := s.Get("acme", reborn); err != nil || v != "new" {
		t.Fatalf("reborn Get = %v, %v", v, err)
	}
	// Delete again and reuse once more: the first token is still dead.
	if err := s.Delete("acme", reborn); err != nil {
		t.Fatalf("Delete reborn: %v", err)
	}
	third := s.Create("acme", "third")
	if _, err := s.Get("acme", old); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("ABA stale token Get = %v, want ErrUnauthorized", err)
	}
	if v, err := s.Get("acme", third); err != nil || v != "third" {
		t.Fatalf("third Get = %v, %v", v, err)
	}
}

func TestBatchGetAllOrNothing(t *testing.T) {
	s := newSeededStore(11)
	t1 := s.Create("acme", "a")
	t2 := s.Create("acme", "b")
	t3 := s.Create("acme", "c")

	vals, err := s.BatchGet("acme", []string{t1, t2, t3})
	if err != nil {
		t.Fatalf("BatchGet: %v", err)
	}
	if len(vals) != 3 || vals[0] != "a" || vals[1] != "b" || vals[2] != "c" {
		t.Fatalf("BatchGet values = %v", vals)
	}

	// One deleted token poisons the whole batch.
	if err := s.Delete("acme", t2); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if vals, err := s.BatchGet("acme", []string{t1, t2, t3}); !errors.Is(err, ErrUnauthorized) || vals != nil {
		t.Fatalf("batch with deleted = %v, %v; want nil, ErrUnauthorized", vals, err)
	}
	// One foreign-tenant token poisons the whole batch.
	other := s.Create("mallory", "x")
	if _, err := s.BatchGet("acme", []string{t1, other}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("batch with foreign token = %v, want ErrUnauthorized", err)
	}
	// One malformed token poisons the whole batch.
	if _, err := s.BatchGet("acme", []string{t1, "not-a-token"}); !errors.Is(err, ErrMalformedToken) {
		t.Fatalf("batch with malformed = %v, want ErrMalformedToken", err)
	}
	// Batch under the wrong tenant fails even for otherwise-valid tokens.
	if _, err := s.BatchGet("mallory", []string{t1, t3}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cross-tenant batch = %v, want ErrUnauthorized", err)
	}
}

func TestMalformedTokens(t *testing.T) {
	s := newSeededStore(5)
	for _, tok := range []string{"", "obj1.", "obj1.!!!", "obj1.AAAA", "v2.abcdef"} {
		if _, err := s.Get("acme", tok); !errors.Is(err, ErrMalformedToken) {
			t.Fatalf("Get(%q) = %v, want ErrMalformedToken", tok, err)
		}
	}
}
