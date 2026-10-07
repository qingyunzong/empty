// Package synclib synchronizes a batch of fields to a Store and verifies
// the result by reading it back. Comparison is normalized only through
// explicitly declared equivalence rules; attachments compare as an
// unordered multiset of content hashes.
package synclib

import (
	"crypto/sha256"
	"encoding/hex"
)

// Attachment is a named binary payload. Its Hash covers both name and data.
type Attachment struct {
	Name string
	Data []byte
}

// Hash returns the hex-encoded SHA-256 of the attachment name and data.
func (a Attachment) Hash() string {
	h := sha256.New()
	h.Write([]byte(a.Name))
	h.Write([]byte{0})
	h.Write(a.Data)
	return hex.EncodeToString(h.Sum(nil))
}

// Record is one batch of fields plus attachments under a single ID.
type Record struct {
	ID          string
	Fields      map[string]string
	Attachments []Attachment
}

// attachmentHashes returns the multiset of attachment hashes, so comparison
// is independent of slice order.
func (r Record) attachmentHashes() map[string]int {
	m := make(map[string]int, len(r.Attachments))
	for _, a := range r.Attachments {
		m[a.Hash()]++
	}
	return m
}
