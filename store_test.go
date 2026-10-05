package objstore

import (
	"errors"
	"reflect"
	"testing"
)

func TestTokenEmbedsTenantAndGeneration(t *testing.T) {
	s := NewStoreWithSeed(1)
	tok := s.Create("alice", []byte("hello"))

	info, err := Parse(tok)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if info.Tenant != "alice" {
		t.Errorf("tenant = %q, want %q", info.Tenant, "alice")
	}
	if info.Generation != 1 {
		t.Errorf("generation = %d, want 1", info.Generation)
	}
}

func TestCreateAndGet(t *testing.T) {
	s := NewStoreWithSeed(2)
	tok := s.Create("alice", []byte("payload"))

	obj, err := s.Get("alice", tok)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(obj.Data) != "payload" {
		t.Errorf("data = %q, want %q", obj.Data, "payload")
	}
}

func TestDeleteInvalidatesToken(t *testing.T) {
	s := NewStoreWithSeed(3)
	tok := s.Create("alice", []byte("x"))

	if err := s.Delete("alice", tok); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get("alice", tok); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("Get after delete: err = %v, want ErrInvalidToken", err)
	}
	if err := s.Delete("alice", tok); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("second Delete: err = %v, want ErrInvalidToken", err)
	}
}

// TestABAHistory exercises the full ABA scenario: a handle is deleted and
// its internal ID reused twice; every historical token must stay dead.
func TestABAHistory(t *testing.T) {
	s := NewStoreWithSeed(4)

	tokA := s.Create("alice", []byte("gen-1"))
	if err := s.Delete("alice", tokA); err != nil {
		t.Fatalf("Delete A: %v", err)
	}

	tokB := s.Create("alice", []byte("gen-2"))
	infoA, _ := Parse(tokA)
	infoB, _ := Parse(tokB)
	if infoA.Handle != infoB.Handle {
		t.Fatalf("expected internal ID reuse: handle %d then %d", infoA.Handle, infoB.Handle)
	}
	if infoB.Generation != infoA.Generation+1 {
		t.Fatalf("generation not bumped: %d then %d", infoA.Generation, infoB.Generation)
	}
	if tokA == tokB {
		t.Fatal("reused handle minted an identical token")
	}

	// The old token must not resurrect the new occupant of the handle.
	if _, err := s.Get("alice", tokA); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("stale token A after reuse: err = %v, want ErrInvalidToken", err)
	}
	if obj, err := s.Get("alice", tokB); err != nil || string(obj.Data) != "gen-2" {
		t.Errorf("live token B: obj = %v, err = %v", obj, err)
	}

	// One more round: B dies, C reuses the handle; A and B stay dead.
	if err := s.Delete("alice", tokB); err != nil {
		t.Fatalf("Delete B: %v", err)
	}
	tokC := s.Create("alice", []byte("gen-3"))
	infoC, _ := Parse(tokC)
	if infoC.Handle != infoA.Handle || infoC.Generation != infoA.Generation+2 {
		t.Fatalf("third generation: handle %d gen %d", infoC.Handle, infoC.Generation)
	}
	for name, tok := range map[string]Token{"A": tokA, "B": tokB} {
		if _, err := s.Get("alice", tok); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("stale token %s: err = %v, want ErrInvalidToken", name, err)
		}
	}
	if obj, err := s.Get("alice", tokC); err != nil || string(obj.Data) != "gen-3" {
		t.Errorf("live token C: obj = %v, err = %v", obj, err)
	}
}

func TestCrossTenantDenied(t *testing.T) {
	s := NewStoreWithSeed(5)
	tok := s.Create("alice", []byte("secret"))

	if _, err := s.Get("bob", tok); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("cross-tenant Get: err = %v, want ErrUnauthorized", err)
	}
	if err := s.Delete("bob", tok); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("cross-tenant Delete: err = %v, want ErrUnauthorized", err)
	}
	// Failed cross-tenant delete must not disturb the object.
	if obj, err := s.Get("alice", tok); err != nil || string(obj.Data) != "secret" {
		t.Errorf("object after attack: obj = %v, err = %v", obj, err)
	}
}

func TestCrossTenantTokenIsNotSilentlyInvalid(t *testing.T) {
	s := NewStoreWithSeed(6)
	tok := s.Create("alice", []byte("secret"))

	// A valid foreign token must yield ErrUnauthorized, not ErrInvalidToken,
	// so callers can tell "does not exist" apart from "not yours".
	if _, err := s.Get("bob", tok); !errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrInvalidToken) {
		t.Errorf("err = %v, want pure ErrUnauthorized", err)
	}
}

func TestBatchReadAllOrNothing(t *testing.T) {
	s := NewStoreWithSeed(7)
	tok1 := s.Create("alice", []byte("one"))
	tok2 := s.Create("alice", []byte("two"))

	objs, err := s.GetBatch("alice", []Token{tok1, tok2})
	if err != nil {
		t.Fatalf("GetBatch: %v", err)
	}
	got := []string{string(objs[0].Data), string(objs[1].Data)}
	if !reflect.DeepEqual(got, []string{"one", "two"}) {
		t.Errorf("batch data = %v", got)
	}

	// A single foreign token poisons the whole batch.
	foreign := s.Create("bob", []byte("bob's"))
	if objs, err := s.GetBatch("alice", []Token{tok1, foreign, tok2}); !errors.Is(err, ErrUnauthorized) || objs != nil {
		t.Errorf("batch with foreign token: objs = %v, err = %v", objs, err)
	}

	// A single invalid token poisons the whole batch.
	dead := s.Create("alice", []byte("dead"))
	if err := s.Delete("alice", dead); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if objs, err := s.GetBatch("alice", []Token{tok1, dead}); !errors.Is(err, ErrInvalidToken) || objs != nil {
		t.Errorf("batch with dead token: objs = %v, err = %v", objs, err)
	}

	// Batch failures are side-effect free: the survivors still read fine.
	if _, err := s.GetBatch("alice", []Token{tok1, tok2}); err != nil {
		t.Errorf("batch after failures: %v", err)
	}
}

func TestSeededRNGIsDeterministic(t *testing.T) {
	a := NewStoreWithSeed(42)
	b := NewStoreWithSeed(42)

	for i := 0; i < 3; i++ {
		ta := a.Create("alice", []byte{byte(i)})
		tb := b.Create("alice", []byte{byte(i)})
		if ta != tb {
			t.Fatalf("same seed, different tokens: %q vs %q", ta, tb)
		}
	}

	c := NewStoreWithSeed(43)
	if ta, tc := a.Create("alice", nil), c.Create("alice", nil); ta == tc {
		t.Errorf("different seeds minted identical token %q", ta)
	}
}

func TestMalformedToken(t *testing.T) {
	s := NewStoreWithSeed(8)
	for _, tok := range []Token{"", "garbage", "v1.zz.1.0.0", "v2.616c696365.1.0.0"} {
		if _, err := s.Get("alice", tok); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("Get(%q): err = %v, want ErrInvalidToken", tok, err)
		}
	}
}
