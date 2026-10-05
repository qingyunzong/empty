package canonenc

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
)

// ErrBadSignature reports a signature mismatch.
var ErrBadSignature = errors.New("canonenc: signature does not match encoded bytes")

// SignatureSize is the length in bytes of a signature produced by Sign.
const SignatureSize = sha256.Size

// Sign computes an HMAC-SHA256 over the encoded byte string. The
// signature binds to the exact encoded bytes, not to the pre-encoding
// plaintext: two different plaintexts with different encodings, and a
// plaintext versus its encoding, always produce distinct signatures.
func Sign(key, encoded []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(encoded)
	return mac.Sum(nil)
}

// Verify reports whether sig is a valid signature over the encoded
// bytes under key. The check runs in constant time.
func Verify(key, encoded, sig []byte) bool {
	if len(sig) != SignatureSize {
		return false
	}
	return hmac.Equal(Sign(key, encoded), sig)
}

// VerifyAndDecode verifies the signature over the encoded bytes and,
// only if it is valid, decodes them. The encoded bytes are never
// decoded before authentication succeeds.
func VerifyAndDecode(key, encoded, sig []byte) ([]byte, error) {
	if !Verify(key, encoded, sig) {
		return nil, ErrBadSignature
	}
	return Decode(encoded)
}
