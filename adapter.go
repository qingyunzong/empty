// Package sigverify verifies signed requests against a registry of keys,
// each valid over a half-open interval [NotBefore, NotAfter).
package sigverify

import (
	"crypto/hmac"
	"crypto/sha256"
)

// Adapter abstracts the signature scheme so the verifier does not depend
// on a concrete cryptographic implementation.
type Adapter interface {
	// Sign produces a signature over payload using the key material.
	Sign(material, payload []byte) []byte
	// Verify reports whether sig is a valid signature over payload.
	Verify(material, payload, sig []byte) bool
}

// FakeAdapter is a deterministic stand-in for a real signature scheme,
// intended for tests and local development only. It uses HMAC-SHA256
// from the standard library; it provides no asymmetric-key properties.
type FakeAdapter struct{}

// Sign returns HMAC-SHA256(material, payload).
func (FakeAdapter) Sign(material, payload []byte) []byte {
	mac := hmac.New(sha256.New, material)
	mac.Write(payload)
	return mac.Sum(nil)
}

// Verify reports whether sig equals the expected HMAC, in constant time.
func (FakeAdapter) Verify(material, payload, sig []byte) bool {
	expected := FakeAdapter{}.Sign(material, payload)
	return hmac.Equal(expected, sig)
}
