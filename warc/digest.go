package warc

import (
	"bytes"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"hash"
	"strings"
)

// splitDigest parses a "scheme:value" digest such as "sha1:AB3F...".
// The scheme is lower-cased and the value upper-cased so digests
// compare equal regardless of presentation case.
func splitDigest(d string) (scheme, value string, err error) {
	i := strings.Index(d, ":")
	if i <= 0 || i == len(d)-1 {
		return "", "", fmt.Errorf("%w: %q", ErrInvalidDigest, d)
	}
	return strings.ToLower(strings.TrimSpace(d[:i])),
		strings.ToUpper(strings.TrimSpace(d[i+1:])), nil
}

// digestsEqual reports whether two digest strings name the same
// algorithm and value.
func digestsEqual(a, b string) (bool, error) {
	as, av, err := splitDigest(a)
	if err != nil {
		return false, err
	}
	bs, bv, err := splitDigest(b)
	if err != nil {
		return false, err
	}
	return as == bs && av == bv, nil
}

func hasher(scheme string) (func() hash.Hash, error) {
	switch scheme {
	case "sha1":
		return sha1.New, nil
	case "sha256":
		return sha256.New, nil
	case "sha512":
		return sha512.New, nil
	case "md5":
		return md5.New, nil
	}
	return nil, fmt.Errorf("%w: %q", ErrUnsupportedDigestScheme, scheme)
}

// decodeDigestValue decodes a hex or base32 (padded or unpadded)
// digest value into raw bytes.
func decodeDigestValue(v string) ([]byte, error) {
	if b, err := hex.DecodeString(v); err == nil {
		return b, nil
	}
	if b, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(v); err == nil {
		return b, nil
	}
	if b, err := base32.StdEncoding.DecodeString(v); err == nil {
		return b, nil
	}
	return nil, fmt.Errorf("%w: value %q is neither hex nor base32", ErrInvalidDigest, v)
}

// verifyDigest checks that digest is a supported "scheme:value" digest
// of payload.
func verifyDigest(digest string, payload []byte) error {
	scheme, value, err := splitDigest(digest)
	if err != nil {
		return err
	}
	newHash, err := hasher(scheme)
	if err != nil {
		return err
	}
	want, err := decodeDigestValue(value)
	if err != nil {
		return err
	}
	h := newHash()
	h.Write(payload)
	if !bytes.Equal(h.Sum(nil), want) {
		return fmt.Errorf("%w: %s digest does not match payload", ErrPayloadDigestMismatch, scheme)
	}
	return nil
}
