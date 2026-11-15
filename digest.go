package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrInvalidDigest reports a digest that is not a SHA-256 digest.
var ErrInvalidDigest = errors.New("dataeng: invalid shard digest")

const digestPrefix = "sha256:"

// SHA256Digest returns the canonical digest of the supplied compressed bytes.
func SHA256Digest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return digestPrefix + hex.EncodeToString(sum[:])
}

// NormalizeDigest accepts either "sha256:<hex>" or a bare SHA-256 hex string
// and returns the canonical "sha256:<lower-case hex>" form.
func NormalizeDigest(digest string) (string, error) {
	d := strings.ToLower(strings.TrimSpace(digest))
	if strings.Contains(d, ":") {
		if !strings.HasPrefix(d, digestPrefix) {
			return "", fmt.Errorf("%w: unsupported digest %q", ErrInvalidDigest, digest)
		}
		d = strings.TrimPrefix(d, digestPrefix)
	}
	if len(d) != sha256.Size*2 {
		return "", fmt.Errorf("%w: sha256 digest must contain %d hex characters", ErrInvalidDigest, sha256.Size*2)
	}
	raw, err := hex.DecodeString(d)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidDigest, err)
	}
	return digestPrefix + hex.EncodeToString(raw), nil
}

func digestEqual(a, b string) bool {
	na, errA := NormalizeDigest(a)
	nb, errB := NormalizeDigest(b)
	return errA == nil && errB == nil && na == nb
}
