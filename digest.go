package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// SHA256Digest consumes r fully and returns a SHA-256 Digest over its bytes.
// It is the canonical way for an archiver to build the Message.Digest from
// a fetched RFC 5322 body.
func SHA256Digest(r io.Reader) (Digest, error) {
	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return Digest{}, err
	}
	return Digest{
		Alg:  "sha256",
		Hex:  hex.EncodeToString(h.Sum(nil)),
		Size: n,
	}, nil
}

// Equal reports whether two digests describe the same content. Two zero
// digests are considered equal.
func (d Digest) Equal(other Digest) bool {
	return d.Alg == other.Alg && d.Hex == other.Hex && d.Size == other.Size
}

// IsZero reports whether the digest is unset.
func (d Digest) IsZero() bool {
	return d.Alg == "" && d.Hex == "" && d.Size == 0
}
