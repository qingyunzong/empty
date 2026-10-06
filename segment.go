package main

import (
	"crypto/sha256"
	"encoding/hex"
)

// Segment is one link in a hash chain. Digest is the claimed identity of the
// segment; when empty it is computed from Prev and Payload on load.
type Segment struct {
	Payload string `json:"payload"`
	Prev    string `json:"prev"`   // claimed digest of the parent, "" for genesis
	Digest  string `json:"digest"` // claimed digest of this segment
	Line    int    `json:"-"`      // 1-based line number in the source file
}

// ComputeDigest derives the content address of a segment.
func ComputeDigest(prev, payload string) string {
	h := sha256.New()
	h.Write([]byte(prev))
	h.Write([]byte{0})
	h.Write([]byte(payload))
	return hex.EncodeToString(h.Sum(nil))
}
