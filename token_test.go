package captoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"
)

var (
	testKey = []byte("test-secret-key")
	t0      = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
)

// hmacVerifier is an injectable Verifier backed by HMAC-SHA256.
type hmacVerifier struct{ key []byte }

func (v hmacVerifier) sign(payload []byte) []byte {
	mac := hmac.New(sha256.New, v.key)
	mac.Write(payload)
	return mac.Sum(nil)
}

func (v hmacVerifier) Verify(payload, signature []byte) error {
	if !hmac.Equal(v.sign(payload), signature) {
		return errors.New("hmac mismatch")
	}
	return nil
}

// mint builds a token and signs it with the test key.
func mint(id, parent, resource string, actions []string, nb, na time.Time) *Token {
	t := &Token{
		ID:        id,
		Parent:    parent,
		Resource:  resource,
		Actions:   actions,
		NotBefore: nb,
		NotAfter:  na,
	}
	t.Signature = hmacVerifier{testKey}.sign(t.payload())
	return t
}

func newStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(hmacVerifier{testKey})
}

func TestHalfOpenValidity(t *testing.T) {
	tok := mint("r", "", "/data", []string{"read"}, t0, t0.Add(time.Hour))
	cases := []struct {
		at    time.Time
		valid bool
	}{
		{t0.Add(-time.Nanosecond), false}, // before window
		{t0, true},                        // inclusive lower bound
		{t0.Add(30 * time.Minute), true},
		{t0.Add(time.Hour), false}, // exclusive upper bound
	}
	for _, c := range cases {
		if got := tok.Contains(c.at); got != c.valid {
			t.Errorf("Contains(%s) = %v, want %v", c.at, got, c.valid)
		}
	}
}

func TestAttenuateNarrowsOK(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read", "write", "delete"}, t0, t0.Add(24*time.Hour))
	if err := s.AddRoot(root); err != nil {
		t.Fatalf("AddRoot: %v", err)
	}
	child := mint("child", "root", "/data/team", []string{"read", "write"}, t0.Add(time.Hour), t0.Add(12*time.Hour))
	if err := s.Attenuate("root", child); err != nil {
		t.Fatalf("Attenuate: %v", err)
	}
	grand := mint("grand", "child", "/data/team/a", []string{"read"}, t0.Add(2*time.Hour), t0.Add(6*time.Hour))
	if err := s.Attenuate("child", grand); err != nil {
		t.Fatalf("Attenuate grandchild: %v", err)
	}
}

func TestAttenuateRejectsWidening(t *testing.T) {
	setup := func() *Store {
		s := newStore(t)
		root := mint("root", "", "/data", []string{"read", "write"}, t0, t0.Add(24*time.Hour))
		if err := s.AddRoot(root); err != nil {
			t.Fatalf("AddRoot: %v", err)
		}
		return s
	}

	t.Run("resource", func(t *testing.T) {
		s := setup()
		child := mint("c", "root", "/other", []string{"read"}, t0, t0.Add(time.Hour))
		if err := s.Attenuate("root", child); !errors.Is(err, ErrResourceWidened) {
			t.Fatalf("got %v, want ErrResourceWidened", err)
		}
	})

	t.Run("actions", func(t *testing.T) {
		s := setup()
		child := mint("c", "root", "/data/x", []string{"read", "delete"}, t0, t0.Add(time.Hour))
		if err := s.Attenuate("root", child); !errors.Is(err, ErrActionsWidened) {
			t.Fatalf("got %v, want ErrActionsWidened", err)
		}
	})

	t.Run("validity start earlier", func(t *testing.T) {
		s := setup()
		child := mint("c", "root", "/data/x", []string{"read"}, t0.Add(-time.Hour), t0.Add(time.Hour))
		if err := s.Attenuate("root", child); !errors.Is(err, ErrValidityExtended) {
			t.Fatalf("got %v, want ErrValidityExtended", err)
		}
	})

	t.Run("validity end later", func(t *testing.T) {
		s := setup()
		child := mint("c", "root", "/data/x", []string{"read"}, t0, t0.Add(48*time.Hour))
		if err := s.Attenuate("root", child); !errors.Is(err, ErrValidityExtended) {
			t.Fatalf("got %v, want ErrValidityExtended", err)
		}
	})

	t.Run("equal bounds allowed", func(t *testing.T) {
		s := setup()
		child := mint("c", "root", "/data", []string{"read", "write"}, t0, t0.Add(24*time.Hour))
		if err := s.Attenuate("root", child); err != nil {
			t.Fatalf("equal bounds should be accepted, got %v", err)
		}
	})
}

func TestVerifyReturnsChainEvidence(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read", "write"}, t0, t0.Add(24*time.Hour))
	child := mint("child", "root", "/data/team", []string{"read"}, t0, t0.Add(12*time.Hour))
	grand := mint("grand", "child", "/data/team/a", []string{"read"}, t0, t0.Add(6*time.Hour))
	for _, err := range []error{
		s.AddRoot(root),
		s.Attenuate("root", child),
		s.Attenuate("child", grand),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}

	at := t0.Add(3 * time.Hour)
	ev, err := s.Verify("grand", at)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if len(ev.Links) != 3 {
		t.Fatalf("evidence has %d links, want 3", len(ev.Links))
	}
	wantOrder := []string{"grand", "child", "root"}
	for i, id := range wantOrder {
		link := ev.Links[i]
		if link.TokenID != id {
			t.Errorf("link %d token = %q, want %q", i, link.TokenID, id)
		}
		if !link.SignatureValid || !link.NotRevoked || !link.ValidAt || !link.AttenuationValid {
			t.Errorf("link %d (%s) has failed checks: %+v", i, id, link)
		}
	}
}

func TestRevokeAncestorInvalidatesDescendants(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read", "write"}, t0, t0.Add(24*time.Hour))
	child := mint("child", "root", "/data/team", []string{"read"}, t0, t0.Add(12*time.Hour))
	grand := mint("grand", "child", "/data/team/a", []string{"read"}, t0, t0.Add(6*time.Hour))
	for _, err := range []error{
		s.AddRoot(root),
		s.Attenuate("root", child),
		s.Attenuate("child", grand),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}

	at := t0.Add(3 * time.Hour)
	if err := s.Revoke("child"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	if _, err := s.Verify("grand", at); !errors.Is(err, ErrRevoked) {
		t.Fatalf("grandchild: got %v, want ErrRevoked", err)
	}
	if _, err := s.Verify("child", at); !errors.Is(err, ErrRevoked) {
		t.Fatalf("child: got %v, want ErrRevoked", err)
	}
	if _, err := s.Verify("root", at); err != nil {
		t.Fatalf("root must stay valid, got %v", err)
	}
}

func TestVerifyValidityWindow(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read"}, t0, t0.Add(time.Hour))
	if err := s.AddRoot(root); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Verify("root", t0.Add(-time.Second)); !errors.Is(err, ErrNotYetValid) {
		t.Fatalf("before window: got %v, want ErrNotYetValid", err)
	}
	if _, err := s.Verify("root", t0.Add(time.Hour)); !errors.Is(err, ErrExpired) {
		t.Fatalf("at exclusive end: got %v, want ErrExpired", err)
	}
	if _, err := s.Verify("root", t0); err != nil {
		t.Fatalf("at inclusive start: got %v", err)
	}
}

func TestBadSignatureRejected(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read"}, t0, t0.Add(time.Hour))
	root.Signature = []byte("forged")
	if err := s.AddRoot(root); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("AddRoot: got %v, want ErrBadSignature", err)
	}

	// A token signed with a different key must also be rejected.
	other := mint("other", "", "/data", []string{"read"}, t0, t0.Add(time.Hour))
	other.Signature = hmacVerifier{[]byte("wrong-key")}.sign(other.payload())
	if err := s.AddRoot(other); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("AddRoot wrong key: got %v, want ErrBadSignature", err)
	}
}

func TestCheckTree(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read", "write"}, t0, t0.Add(24*time.Hour))
	a := mint("a", "root", "/data/a", []string{"read"}, t0, t0.Add(12*time.Hour))
	b := mint("b", "root", "/data/b", []string{"write"}, t0, t0.Add(12*time.Hour))
	a1 := mint("a1", "a", "/data/a/1", []string{"read"}, t0, t0.Add(6*time.Hour))
	for _, err := range []error{
		s.AddRoot(root),
		s.Attenuate("root", a),
		s.Attenuate("root", b),
		s.Attenuate("a", a1),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Revoke("a"); err != nil {
		t.Fatal(err)
	}

	at := t0.Add(3 * time.Hour)
	results, err := s.CheckTree("root", at)
	if err != nil {
		t.Fatalf("CheckTree: %v", err)
	}
	if len(results) != 4 {
		t.Fatalf("enumerated %d nodes, want 4", len(results))
	}
	valid := map[string]bool{}
	for _, r := range results {
		valid[r.TokenID] = r.Valid
	}
	want := map[string]bool{"root": true, "a": false, "b": true, "a1": false}
	for id, w := range want {
		if valid[id] != w {
			t.Errorf("node %q valid = %v, want %v", id, valid[id], w)
		}
	}
	if !errors.Is(results[1].Err, ErrRevoked) {
		t.Errorf("node a err = %v, want ErrRevoked", results[1].Err)
	}
}

func TestStoreGuards(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read"}, t0, t0.Add(time.Hour))
	if err := s.AddRoot(root); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRoot(root); !errors.Is(err, ErrDuplicateToken) {
		t.Errorf("duplicate: got %v, want ErrDuplicateToken", err)
	}
	if _, err := s.Verify("missing", t0); !errors.Is(err, ErrUnknownToken) {
		t.Errorf("verify missing: got %v, want ErrUnknownToken", err)
	}
	if err := s.Revoke("missing"); !errors.Is(err, ErrUnknownToken) {
		t.Errorf("revoke missing: got %v, want ErrUnknownToken", err)
	}
	orphan := mint("orphan", "ghost", "/data/x", []string{"read"}, t0, t0.Add(time.Hour))
	if err := s.Attenuate("ghost", orphan); !errors.Is(err, ErrUnknownToken) {
		t.Errorf("attenuate under missing parent: got %v, want ErrUnknownToken", err)
	}
	mislabeled := mint("m", "other", "/data/x", []string{"read"}, t0, t0.Add(time.Hour))
	if err := s.Attenuate("root", mislabeled); !errors.Is(err, ErrNotChildOfParent) {
		t.Errorf("parent mismatch: got %v, want ErrNotChildOfParent", err)
	}
	bad := mint("bad", "", "/data", []string{"read"}, t0, t0) // empty window
	bad.Signature = hmacVerifier{testKey}.sign(bad.payload())
	if err := s.AddRoot(bad); !errors.Is(err, ErrEmptyWindow) {
		t.Errorf("empty window: got %v, want ErrEmptyWindow", err)
	}
	notRoot := mint("nr", "root", "/data/x", []string{"read"}, t0, t0.Add(time.Hour))
	if err := s.AddRoot(notRoot); !errors.Is(err, ErrRootHasParent) {
		t.Errorf("root with parent: got %v, want ErrRootHasParent", err)
	}
}

func TestVerifierFuncInjection(t *testing.T) {
	// A store with an accept-all verifier must accept unsigned tokens,
	// demonstrating the verifier is fully injectable.
	s := NewStore(VerifierFunc(func(payload, signature []byte) error { return nil }))
	root := &Token{
		ID:        "root",
		Resource:  "/data",
		Actions:   []string{"read"},
		NotBefore: t0,
		NotAfter:  t0.Add(time.Hour),
	}
	if err := s.AddRoot(root); err != nil {
		t.Fatalf("AddRoot with injected verifier: %v", err)
	}
	if _, err := s.Verify("root", t0); err != nil {
		t.Fatalf("Verify with injected verifier: %v", err)
	}
}

func TestChildrenEnumeration(t *testing.T) {
	s := newStore(t)
	root := mint("root", "", "/data", []string{"read"}, t0, t0.Add(time.Hour))
	c1 := mint("c1", "root", "/data/1", []string{"read"}, t0, t0.Add(time.Hour))
	c2 := mint("c2", "root", "/data/2", []string{"read"}, t0, t0.Add(time.Hour))
	for _, err := range []error{s.AddRoot(root), s.Attenuate("root", c2), s.Attenuate("root", c1)} {
		if err != nil {
			t.Fatal(err)
		}
	}
	got := strings.Join(s.Children("root"), ",")
	if got != "c1,c2" {
		t.Fatalf("Children = %q, want %q", got, "c1,c2")
	}
}
