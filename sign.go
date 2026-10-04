package canonenc

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
)

// ErrSignature reports a signature mismatch over encoded bytes.
var ErrSignature = errors.New("canonenc: signature mismatch")

// SigLen is the length in bytes of signatures produced by Sign.
const SigLen = sha256.Size

// Sign returns HMAC-SHA256(key, encoded). The signature binds to the
// exact encoded byte stream: because Decode accepts only the canonical
// encoding of any plaintext, a verifier that checks the signature before
// decoding cannot be confused by alternative spellings of the same
// plaintext — any non-canonical respelling changes the signed bytes and
// fails Verify, and would be rejected by Decode anyway.
func Sign(key, encoded []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(encoded)
	return mac.Sum(nil)
}

// Verify reports whether sig is a valid signature of encoded under key.
func Verify(key, encoded, sig []byte) bool {
	if len(sig) != SigLen {
		return false
	}
	return hmac.Equal(Sign(key, encoded), sig)
}

// Seal canonically encodes plaintext and returns the encoding together
// with its signature under key.
func Seal(key, plaintext []byte) (encoded, sig []byte) {
	encoded = EncodeString(plaintext)
	return encoded, Sign(key, encoded)
}

// Open verifies sig over encoded and, only if the signature is valid,
// decodes encoded. A signature mismatch yields ErrSignature; a validly
// signed but non-canonical or truncated encoding yields the decode error.
func Open(key, encoded, sig []byte) ([]byte, error) {
	if !Verify(key, encoded, sig) {
		return nil, fmt.Errorf("%w", ErrSignature)
	}
	return DecodeString(encoded)
}
