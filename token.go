package objstore

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// ErrMalformedToken is returned when a token cannot be parsed at all.
var ErrMalformedToken = errors.New("objstore: malformed token")

// tokenPayload is the decoded content of an external token.
// A token carries the tenant, the internal object ID, the generation of
// that ID, and a random nonce, so stale or foreign tokens can be rejected
// without ambiguity.
type tokenPayload struct {
	tenantID   uint64
	objectID   uint64
	generation uint64
	nonce      uint64
}

const (
	tokenPrefix  = "obj1."
	tokenRawSize = 32 // 4 x uint64
)

func encodeToken(p tokenPayload) string {
	var buf [tokenRawSize]byte
	binary.BigEndian.PutUint64(buf[0:8], p.tenantID)
	binary.BigEndian.PutUint64(buf[8:16], p.objectID)
	binary.BigEndian.PutUint64(buf[16:24], p.generation)
	binary.BigEndian.PutUint64(buf[24:32], p.nonce)
	return tokenPrefix + base64.RawURLEncoding.EncodeToString(buf[:])
}

func decodeToken(tok string) (tokenPayload, error) {
	var p tokenPayload
	if !strings.HasPrefix(tok, tokenPrefix) {
		return p, fmt.Errorf("%w: bad prefix", ErrMalformedToken)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(tok, tokenPrefix))
	if err != nil || len(raw) != tokenRawSize {
		return p, fmt.Errorf("%w: bad encoding", ErrMalformedToken)
	}
	p.tenantID = binary.BigEndian.Uint64(raw[0:8])
	p.objectID = binary.BigEndian.Uint64(raw[8:16])
	p.generation = binary.BigEndian.Uint64(raw[16:24])
	p.nonce = binary.BigEndian.Uint64(raw[24:32])
	return p, nil
}
