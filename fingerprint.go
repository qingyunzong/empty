package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// ContentFingerprint returns the lowercase SHA-256 hex digest of content.
// lastmod values are deliberately not part of the fingerprint.
func ContentFingerprint(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// Fingerprint is an alias for ContentFingerprint.
func Fingerprint(content []byte) string { return ContentFingerprint(content) }

// HashContent is an alias for ContentFingerprint.
func HashContent(content []byte) string { return ContentFingerprint(content) }

// ContentFingerprintString fingerprints a string without a []byte copy.
func ContentFingerprintString(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// FingerprintString is an alias for ContentFingerprintString.
func FingerprintString(content string) string { return ContentFingerprintString(content) }

// ContentFingerprintReader fingerprints a stream.
func ContentFingerprintReader(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
