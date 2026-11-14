package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

const digestPrefix = "sha256:"

// Digest returns the canonical content digest used by this package.
func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return digestPrefix + hex.EncodeToString(sum[:])
}

// DigestReader computes the canonical content digest of a stream.
func DigestReader(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return digestPrefix + hex.EncodeToString(h.Sum(nil)), nil
}

func digestHex(d string) (string, error) {
	if !strings.HasPrefix(d, digestPrefix) {
		return "", fmt.Errorf("%w: %q is not a sha256 digest", ErrCorrupt, d)
	}
	h := d[len(digestPrefix):]
	if len(h) != sha256.Size*2 {
		return "", fmt.Errorf("%w: %q has an invalid sha256 length", ErrCorrupt, d)
	}
	if _, err := hex.DecodeString(h); err != nil {
		return "", fmt.Errorf("%w: %q is not hexadecimal", ErrCorrupt, d)
	}
	return h, nil
}

func validDigest(d string) bool {
	_, err := digestHex(d)
	return err == nil
}

// objectToken returns a stable token for an object's exact bytes. The empty
// string represents an absent object and can therefore be used as the
// If-None-Match precondition for the first HEAD write.
func objectToken(data []byte) string {
	if data == nil {
		return ""
	}
	return Digest(data)
}
