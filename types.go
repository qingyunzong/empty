// Package fieldsync writes a batch of fields to a Store and verifies the
// result by reading it back. Comparison applies only explicitly declared
// equivalence rules; attachments are compared as an order-insensitive
// multiset of content hashes.
package fieldsync

import (
	"crypto/sha256"
	"encoding/hex"
)

// Attachment is a binary payload identified by ID. Equality is derived from
// the SHA-256 of Data, never from position within a batch.
type Attachment struct {
	ID   string
	Data []byte
}

// Hash returns the hex-encoded SHA-256 of the attachment payload.
func (a Attachment) Hash() string {
	sum := sha256.Sum256(a.Data)
	return hex.EncodeToString(sum[:])
}

// Batch is a set of named fields plus attachments written atomically.
type Batch struct {
	Fields      map[string]string
	Attachments []Attachment
}

// Receipt is the storage-level acknowledgement returned by a write. It is
// preserved verbatim on verification failures so callers can correlate the
// bad state with the write that produced it.
type Receipt struct {
	Version uint64
	Token   string
}

// IsZero reports whether the receipt is the empty pre-write value.
func (r Receipt) IsZero() bool { return r.Version == 0 && r.Token == "" }
