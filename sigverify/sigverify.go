// Package sigverify verifies request signatures by key ID against keys that
// are valid over a half-open interval [NotBefore, NotAfter). Key rotation is
// expressed by registering successive key versions whose validity windows
// explicitly overlap. Revoking a key makes it invalid immediately, regardless
// of its remaining validity window. Both the request signing time and the
// receipt time are checked against the key's window.
package sigverify

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	ErrUnknownKey      = errors.New("sigverify: unknown key ID")
	ErrKeyRevoked      = errors.New("sigverify: key has been revoked")
	ErrOutsideValidity = errors.New("sigverify: time outside key validity window")
	ErrBadSignature    = errors.New("sigverify: signature mismatch")
)

// Key is a single version of a signing key. It is valid for the half-open
// interval [NotBefore, NotAfter): NotBefore is inclusive, NotAfter exclusive.
type Key struct {
	ID        string
	Secret    []byte
	NotBefore time.Time
	NotAfter  time.Time // exclusive
	RevokedAt *time.Time
}

// validAt reports whether t falls inside [NotBefore, NotAfter).
func (k *Key) validAt(t time.Time) bool {
	return !t.Before(k.NotBefore) && t.Before(k.NotAfter)
}

// revokedAt reports whether the key is revoked as of t. Revocation is
// immediate: any verification performed at or after RevokedAt fails.
func (k *Key) revokedAt(t time.Time) bool {
	return k.RevokedAt != nil && !t.Before(*k.RevokedAt)
}

// Signer abstracts the signature algorithm so tests can plug in a fake
// adapter instead of real asymmetric crypto.
type Signer interface {
	Sign(secret, payload []byte) []byte
	Verify(secret, payload, signature []byte) bool
}

// FakeSigner is a deterministic HMAC-SHA256 adapter standing in for a real
// signature scheme. It uses only the Go standard library.
type FakeSigner struct{}

func (FakeSigner) Sign(secret, payload []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return mac.Sum(nil)
}

func (f FakeSigner) Verify(secret, payload, signature []byte) bool {
	return hmac.Equal(f.Sign(secret, payload), signature)
}

// Registry stores key versions by ID. Multiple versions of the same ID may
// coexist so rotation windows can overlap explicitly.
type Registry struct {
	mu   sync.RWMutex
	keys map[string][]*Key
}

func NewRegistry() *Registry {
	return &Registry{keys: make(map[string][]*Key)}
}

// Add registers a key version. NotBefore must be strictly before NotAfter.
func (r *Registry) Add(k *Key) error {
	if k.ID == "" {
		return errors.New("sigverify: key ID must not be empty")
	}
	if !k.NotBefore.Before(k.NotAfter) {
		return fmt.Errorf("sigverify: key %q has empty validity window", k.ID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	versions := append(r.keys[k.ID], k)
	sort.Slice(versions, func(i, j int) bool {
		return versions[i].NotBefore.Before(versions[j].NotBefore)
	})
	r.keys[k.ID] = versions
	return nil
}

// Revoke marks every version of id as revoked at the given time.
func (r *Registry) Revoke(id string, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	versions, ok := r.keys[id]
	if !ok {
		return ErrUnknownKey
	}
	for _, k := range versions {
		t := at
		k.RevokedAt = &t
	}
	return nil
}

func (r *Registry) lookup(id string) []*Key {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.keys[id]
}

// Verifier checks signatures against a registry using a Signer.
type Verifier struct {
	reg    *Registry
	signer Signer
}

func NewVerifier(reg *Registry, signer Signer) *Verifier {
	return &Verifier{reg: reg, signer: signer}
}

// Verify checks that signature is valid for payload under keyID, and that
// both the signing time (signedAt) and the receipt time (receivedAt) fall
// within the key's half-open validity window, and that the key was not
// revoked by receivedAt. An unknown key ID is never treated as valid.
func (v *Verifier) Verify(keyID string, payload, signature []byte, signedAt, receivedAt time.Time) error {
	versions := v.reg.lookup(keyID)
	if len(versions) == 0 {
		return ErrUnknownKey
	}
	// The signature identifies which key version produced it: versions
	// whose secret does not verify the signature are not candidates.
	var candidates []*Key
	for _, k := range versions {
		if v.signer.Verify(k.Secret, payload, signature) {
			candidates = append(candidates, k)
		}
	}
	if len(candidates) == 0 {
		return ErrBadSignature
	}
	sawRevoked := false
	for _, k := range candidates {
		switch {
		case k.revokedAt(receivedAt):
			sawRevoked = true
		case !k.validAt(signedAt) || !k.validAt(receivedAt):
			// Signing or receipt outside the half-open window.
		default:
			return nil
		}
	}
	if sawRevoked {
		return ErrKeyRevoked
	}
	return ErrOutsideValidity
}
