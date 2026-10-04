package capability

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

var (
	t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 = t0.Add(time.Hour)
	t2 = t0.Add(2 * time.Hour)
)

// hmacVerifier is an injectable verifier built only on the standard library.
type hmacVerifier struct{ key []byte }

func (v hmacVerifier) Verify(payload, signature []byte) bool {
	mac := hmac.New(sha256.New, v.key)
	mac.Write(payload)
	return hmac.Equal(mac.Sum(nil), signature)
}

func sign(key []byte, t Token) Token {
	mac := hmac.New(sha256.New, key)
	mac.Write(t.SigningPayload())
	t.Signature = mac.Sum(nil)
	return t
}

var key = []byte("test-key")

func rootToken() Token {
	return sign(key, Token{
		ID: "root", Resource: "/data/", Actions: []string{"read", "write"},
		NotBefore: t0, NotAfter: t2,
	})
}

func childToken() Token {
	return sign(key, Token{
		ID: "child", Parent: "root", Resource: "/data/public/", Actions: []string{"read"},
		NotBefore: t0, NotAfter: t1,
	})
}

func grandchildToken() Token {
	return sign(key, Token{
		ID: "grandchild", Parent: "child", Resource: "/data/public/img/", Actions: []string{"read"},
		NotBefore: t0.Add(30 * time.Minute), NotAfter: t1,
	})
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s := NewStore(hmacVerifier{key})
	if err := s.MintRoot(rootToken()); err != nil {
		t.Fatalf("MintRoot: %v", err)
	}
	if err := s.Attenuate("root", childToken()); err != nil {
		t.Fatalf("Attenuate child: %v", err)
	}
	if err := s.Attenuate("child", grandchildToken()); err != nil {
		t.Fatalf("Attenuate grandchild: %v", err)
	}
	return s
}

func TestVerifyReturnsChainEvidence(t *testing.T) {
	s := newStore(t)
	chain, err := s.Verify("grandchild", t0.Add(45*time.Minute))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got, want := len(chain.Tokens), 3; got != want {
		t.Fatalf("chain length = %d, want %d", got, want)
	}
	if chain.Root().ID != "root" || chain.Leaf().ID != "grandchild" {
		t.Fatalf("chain = %q..%q, want root..grandchild", chain.Root().ID, chain.Leaf().ID)
	}
	if chain.Tokens[1].ID != "child" {
		t.Fatalf("middle link = %q, want child", chain.Tokens[1].ID)
	}
}

func TestHalfOpenValidity(t *testing.T) {
	s := newStore(t)
	if _, err := s.Verify("child", t0); err != nil {
		t.Fatalf("valid at NotBefore (inclusive): %v", err)
	}
	if _, err := s.Verify("child", t1); !errors.Is(err, ErrExpired) {
		t.Fatalf("at NotAfter (exclusive) err = %v, want ErrExpired", err)
	}
	if _, err := s.Verify("child", t0.Add(-time.Nanosecond)); !errors.Is(err, ErrExpired) {
		t.Fatalf("before NotBefore err = %v, want ErrExpired", err)
	}
	// Grandchild validity ends at t1 too, but starts later.
	if _, err := s.Verify("grandchild", t0.Add(15*time.Minute)); !errors.Is(err, ErrExpired) {
		t.Fatalf("before grandchild NotBefore err = %v, want ErrExpired", err)
	}
}

func TestAttenuationOnlyNarrows(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Token)
	}{
		{"resource escapes prefix", func(c *Token) { c.Resource = "/other/" }},
		{"action not in parent", func(c *Token) { c.Actions = []string{"read", "delete"} }},
		{"notbefore earlier", func(c *Token) { c.NotBefore = t0.Add(-time.Minute) }},
		{"notafter later", func(c *Token) { c.NotAfter = t2.Add(time.Hour) }},
		{"empty interval", func(c *Token) { c.NotBefore, c.NotAfter = t1, t1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newStore(t)
			child := childToken()
			child.ID = "child2"
			tc.mutate(&child)
			child = sign(key, child)
			if err := s.Attenuate("root", child); !errors.Is(err, ErrNotAttenuation) {
				t.Fatalf("Attenuate err = %v, want ErrNotAttenuation", err)
			}
		})
	}
}

func TestAttenuateUnknownParent(t *testing.T) {
	s := newStore(t)
	c := childToken()
	c.ID, c.Parent = "orphan", "ghost"
	if err := s.Attenuate("ghost", sign(key, c)); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("err = %v, want ErrUnknownToken", err)
	}
}

func TestRevokeAncestorInvalidatesDescendants(t *testing.T) {
	s := newStore(t)
	// A sibling subtree of "child" to confirm it stays valid.
	sibling := sign(key, Token{
		ID: "sibling", Parent: "root", Resource: "/data/private/", Actions: []string{"write"},
		NotBefore: t0, NotAfter: t2,
	})
	if err := s.Attenuate("root", sibling); err != nil {
		t.Fatalf("Attenuate sibling: %v", err)
	}

	if err := s.Revoke("child"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	for _, id := range []string{"child", "grandchild"} {
		if _, err := s.Verify(id, t0.Add(45*time.Minute)); !errors.Is(err, ErrRevoked) {
			t.Fatalf("Verify(%s) after ancestor revoke err = %v, want ErrRevoked", id, err)
		}
	}
	if _, err := s.Verify("sibling", t0.Add(time.Minute)); err != nil {
		t.Fatalf("sibling subtree must stay valid: %v", err)
	}
	if _, err := s.Verify("root", t0.Add(time.Minute)); err != nil {
		t.Fatalf("root must stay valid: %v", err)
	}
}

func TestRevokeRootKillsWholeTree(t *testing.T) {
	s := newStore(t)
	if err := s.Revoke("root"); err != nil {
		t.Fatalf("Revoke root: %v", err)
	}
	for _, id := range []string{"root", "child", "grandchild"} {
		if _, err := s.Verify(id, t0.Add(45*time.Minute)); !errors.Is(err, ErrRevoked) {
			t.Fatalf("Verify(%s) err = %v, want ErrRevoked", id, err)
		}
	}
}

func TestRevokeUnknown(t *testing.T) {
	s := newStore(t)
	if err := s.Revoke("ghost"); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("err = %v, want ErrUnknownToken", err)
	}
}

func TestInjectableVerifier(t *testing.T) {
	// A reject-all verifier blocks minting.
	reject := NewStore(VerifierFunc(func(_, _ []byte) bool { return false }))
	if err := reject.MintRoot(rootToken()); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
	// A tampered signature is rejected by the HMAC verifier.
	s := NewStore(hmacVerifier{key})
	bad := rootToken()
	bad.ID = "tampered"
	bad.Resource = "/" // widened after signing
	if err := s.MintRoot(bad); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
	// Wrong key is rejected.
	if err := s.MintRoot(sign([]byte("other-key"), rootToken())); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}

func TestDuplicatesAndUnknown(t *testing.T) {
	s := newStore(t)
	if err := s.MintRoot(rootToken()); !errors.Is(err, ErrDuplicateToken) {
		t.Fatalf("duplicate root err = %v, want ErrDuplicateToken", err)
	}
	if _, err := s.Verify("ghost", t0); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("verify ghost err = %v, want ErrUnknownToken", err)
	}
}

func TestEnumerateTree(t *testing.T) {
	s := newStore(t)
	sibling := sign(key, Token{
		ID: "sibling", Parent: "root", Resource: "/data/private/", Actions: []string{"write"},
		NotBefore: t0, NotAfter: t2,
	})
	if err := s.Attenuate("root", sibling); err != nil {
		t.Fatalf("Attenuate sibling: %v", err)
	}
	if err := s.Revoke("child"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	entries := s.Enumerate()
	if got, want := len(entries), 4; got != want {
		t.Fatalf("entries = %d, want %d", got, want)
	}
	// Depth-first, children sorted: root, child, grandchild, sibling.
	wantOrder := []string{"root", "child", "grandchild", "sibling"}
	wantDepth := []int{0, 1, 2, 1}
	wantLive := []bool{true, false, false, true}
	for i, e := range entries {
		if e.Token.ID != wantOrder[i] {
			t.Errorf("entries[%d].ID = %q, want %q", i, e.Token.ID, wantOrder[i])
		}
		if e.Depth != wantDepth[i] {
			t.Errorf("entries[%d].Depth = %d, want %d", i, e.Depth, wantDepth[i])
		}
		if e.Live != wantLive[i] {
			t.Errorf("entries[%d].Live = %v, want %v", i, e.Live, wantLive[i])
		}
	}
	// Only "child" itself carries the revocation mark; grandchild is dead
	// through its ancestor.
	if !entries[1].Revoked || entries[2].Revoked {
		t.Errorf("revocation marks wrong: child=%v grandchild=%v", entries[1].Revoked, entries[2].Revoked)
	}
}
