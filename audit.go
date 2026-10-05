// Package auditlog implements a tamper-evident audit log with payload
// redaction. Each record retains the digest of the original payload, the
// redacted payload, and the list of redacted ranges. Records are linked by
// a SHA-256 hash chain that can be replayed from the stored (redacted)
// data alone; original secrets are never written to the log.
package auditlog

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
)

// MaskByte replaces every byte inside a redacted range.
const MaskByte = 0x00

// Range identifies a half-open byte interval [Start, End) of a payload
// that must be redacted.
type Range struct {
	Start int
	End   int
}

// MergeRanges validates ranges against a payload of size bytes and merges
// overlapping or adjacent ranges. Adjacent ranges (e.g. produced when a
// secret spans a chunk boundary) are coalesced into a single range.
func MergeRanges(ranges []Range, size int) ([]Range, error) {
	for i, r := range ranges {
		if r.Start < 0 {
			return nil, fmt.Errorf("range %d: negative start %d", i, r.Start)
		}
		if r.End < r.Start {
			return nil, fmt.Errorf("range %d: end %d before start %d", i, r.End, r.Start)
		}
		if r.End > size {
			return nil, fmt.Errorf("range %d: end %d exceeds payload size %d", i, r.End, size)
		}
	}
	sorted := make([]Range, len(ranges))
	copy(sorted, ranges)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Start != sorted[j].Start {
			return sorted[i].Start < sorted[j].Start
		}
		return sorted[i].End < sorted[j].End
	})
	merged := make([]Range, 0, len(sorted))
	for _, r := range sorted {
		if r.Start == r.End {
			continue // empty range redacts nothing
		}
		if n := len(merged); n > 0 && r.Start <= merged[n-1].End {
			if r.End > merged[n-1].End {
				merged[n-1].End = r.End
			}
			continue
		}
		merged = append(merged, r)
	}
	return merged, nil
}

// ChunkRanges converts ranges expressed relative to fixed-size chunks of a
// payload of total bytes into absolute payload offsets. Chunk boundaries
// are irrelevant to the result; merging happens in MergeRanges.
func ChunkRanges(total, chunkSize int, perChunk [][]Range) ([]Range, error) {
	if chunkSize <= 0 {
		return nil, errors.New("chunk size must be positive")
	}
	var out []Range
	for chunkIdx, rs := range perChunk {
		base := chunkIdx * chunkSize
		if base >= total && len(rs) > 0 {
			return nil, fmt.Errorf("chunk %d starts beyond payload size %d", chunkIdx, total)
		}
		for _, r := range rs {
			out = append(out, Range{Start: base + r.Start, End: base + r.End})
		}
	}
	return out, nil
}

// Redact returns a copy of payload with every byte inside the (merged)
// ranges overwritten with MaskByte, plus the merged range list. The input
// payload is not modified and the original secret bytes are never
// included in the returned values.
func Redact(payload []byte, ranges []Range) ([]byte, []Range, error) {
	merged, err := MergeRanges(ranges, len(payload))
	if err != nil {
		return nil, nil, err
	}
	out := make([]byte, len(payload))
	copy(out, payload)
	for _, r := range merged {
		for i := r.Start; i < r.End; i++ {
			out[i] = MaskByte
		}
	}
	return out, merged, nil
}

// CheckOutsideUnchanged verifies that redacted differs from original only
// inside the given ranges. It returns an error describing the first
// out-of-range mismatch.
func CheckOutsideUnchanged(original, redacted []byte, ranges []Range) error {
	if len(original) != len(redacted) {
		return fmt.Errorf("length changed: %d -> %d", len(original), len(redacted))
	}
	inside := make([]bool, len(original))
	for _, r := range ranges {
		for i := r.Start; i < r.End && i <= len(original); i++ {
			inside[i] = true
		}
	}
	for i := range original {
		if !inside[i] && original[i] != redacted[i] {
			return fmt.Errorf("byte %d outside redaction ranges changed: %#02x -> %#02x", i, original[i], redacted[i])
		}
	}
	return nil
}

// Record is one audit log entry. Payload holds the redacted payload only;
// the original is represented solely by OrigDigest.
type Record struct {
	Index      uint64
	PrevHash   [sha256.Size]byte
	OrigDigest [sha256.Size]byte
	Ranges     []Range
	Payload    []byte // redacted
	Hash       [sha256.Size]byte
}

// Digest computes the SHA-256 digest of an original payload.
func Digest(payload []byte) [sha256.Size]byte {
	return sha256.Sum256(payload)
}

// chainHash recomputes the record's chain hash from its stored fields.
// The hash covers only redacted data, so anyone holding the log can
// replay the chain without access to the original secrets.
func (r *Record) chainHash() [sha256.Size]byte {
	h := sha256.New()
	h.Write(r.PrevHash[:])
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], r.Index)
	h.Write(buf[:])
	h.Write(r.OrigDigest[:])
	binary.BigEndian.PutUint64(buf[:], uint64(len(r.Ranges)))
	h.Write(buf[:])
	for _, rg := range r.Ranges {
		binary.BigEndian.PutUint64(buf[:], uint64(rg.Start))
		h.Write(buf[:])
		binary.BigEndian.PutUint64(buf[:], uint64(rg.End))
		h.Write(buf[:])
	}
	binary.BigEndian.PutUint64(buf[:], uint64(len(r.Payload)))
	h.Write(buf[:])
	h.Write(r.Payload)
	var sum [sha256.Size]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// NewRecord builds the record for a redacted payload, linking it to
// prevHash. origDigest must be Digest(originalPayload).
func NewRecord(index uint64, prevHash, origDigest [sha256.Size]byte, redacted []byte, merged []Range) *Record {
	r := &Record{
		Index:      index,
		PrevHash:   prevHash,
		OrigDigest: origDigest,
		Ranges:     append([]Range(nil), merged...),
		Payload:    append([]byte(nil), redacted...),
	}
	r.Hash = r.chainHash()
	return r
}

// VerifyChain replays the hash chain over stored records and confirms
// every link. It needs no access to original payloads.
func VerifyChain(records []Record) error {
	var prev [sha256.Size]byte
	for i := range records {
		r := &records[i]
		if r.Index != uint64(i) {
			return fmt.Errorf("record %d: unexpected index %d", i, r.Index)
		}
		if !bytes.Equal(r.PrevHash[:], prev[:]) {
			return fmt.Errorf("record %d: prev hash mismatch", i)
		}
		if want := r.chainHash(); !bytes.Equal(r.Hash[:], want[:]) {
			return fmt.Errorf("record %d: hash mismatch", i)
		}
		prev = r.Hash
	}
	return nil
}

// VerifyRecordAgainstOriginal confirms, for a caller that still holds the
// original payload, that the record's digest matches and that no byte
// outside the recorded ranges was altered.
func VerifyRecordAgainstOriginal(r *Record, original []byte) error {
	if got := Digest(original); !bytes.Equal(got[:], r.OrigDigest[:]) {
		return errors.New("original payload digest mismatch")
	}
	return CheckOutsideUnchanged(original, r.Payload, r.Ranges)
}
