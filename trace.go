// Package debugtrace implements a record/replay debugging trace.
//
// A Trace is an append-only log of two kinds of blocks: external inputs
// (nondeterministic data observed by the program) and immutable state
// snapshots. Every block carries a CRC-32 checksum of its payload and a
// SHA-1 hash chained to the previous block, so any tampering or corruption
// is detected and precisely located instead of being silently replayed.
//
// Time-travel jumps restore the nearest snapshot at or before the target
// and replay the remaining inputs from there. Branching forks the trace
// for exploratory debugging without ever mutating the original.
package debugtrace

import (
	"bytes"
	"crypto/sha1"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

// Kind identifies the type of a trace block.
type Kind uint8

const (
	// KindInput is a recorded external input.
	KindInput Kind = iota + 1
	// KindSnapshot is an immutable state block capturing the machine state
	// after all previously appended inputs have been applied.
	KindSnapshot
)

func (k Kind) String() string {
	switch k {
	case KindInput:
		return "input"
	case KindSnapshot:
		return "snapshot"
	default:
		return fmt.Sprintf("kind(%d)", uint8(k))
	}
}

// Entry is a single immutable block in a Trace. Entries returned by the
// Trace API are deep copies; mutating them never affects the trace.
type Entry struct {
	Seq  uint64          // position in the trace, starting at 0
	Kind Kind            // block kind
	Data []byte          // payload (immutable once appended)
	CRC  uint32          // CRC-32 (IEEE) of Data
	Hash [sha1.Size]byte // chain hash over (prev hash, seq, kind, crc, data)
}

// CorruptionError pinpoints the first damaged block in a trace. It is
// returned instead of any replayed state, so callers never receive a
// guessed or silently repaired state.
type CorruptionError struct {
	Seq    uint64
	Reason string
}

func (e *CorruptionError) Error() string {
	return fmt.Sprintf("debugtrace: corrupt block at seq %d: %s", e.Seq, e.Reason)
}

// IsCorruption reports whether err is a *CorruptionError.
func IsCorruption(err error) bool {
	var ce *CorruptionError
	return errors.As(err, &ce)
}

// ErrOutOfRange is returned when a sequence number is outside the trace.
var ErrOutOfRange = errors.New("debugtrace: sequence out of range")

// Trace is an append-only sequence of immutable blocks.
type Trace struct {
	entries []Entry
}

// New returns an empty trace.
func New() *Trace { return &Trace{} }

// Len returns the number of blocks in the trace.
func (t *Trace) Len() int { return len(t.entries) }

// chainHash computes the hash link for a block.
func chainHash(prev [sha1.Size]byte, seq uint64, kind Kind, crc uint32, data []byte) [sha1.Size]byte {
	h := sha1.New()
	h.Write(prev[:])
	var buf [9]byte
	binary.BigEndian.PutUint64(buf[:8], seq)
	buf[8] = byte(kind)
	h.Write(buf[:])
	binary.BigEndian.PutUint32(buf[:4], crc)
	h.Write(buf[:4])
	h.Write(data)
	var sum [sha1.Size]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

func (t *Trace) append(kind Kind, data []byte) uint64 {
	payload := make([]byte, len(data))
	copy(payload, data)
	seq := uint64(len(t.entries))
	var prev [sha1.Size]byte
	if seq > 0 {
		prev = t.entries[seq-1].Hash
	}
	crc := crc32.ChecksumIEEE(payload)
	t.entries = append(t.entries, Entry{
		Seq:  seq,
		Kind: kind,
		Data: payload,
		CRC:  crc,
		Hash: chainHash(prev, seq, kind, crc, payload),
	})
	return seq
}

// AppendInput records an external input block. The data is copied, so the
// caller may reuse or mutate its buffer afterwards.
func (t *Trace) AppendInput(data []byte) uint64 { return t.append(KindInput, data) }

// AppendSnapshot records an immutable state block. The state is copied, so
// later mutations of the caller's buffer cannot affect the trace.
func (t *Trace) AppendSnapshot(state []byte) uint64 { return t.append(KindSnapshot, state) }

// Entry returns a deep copy of the block at seq.
func (t *Trace) Entry(seq uint64) (Entry, error) {
	if seq >= uint64(len(t.entries)) {
		return Entry{}, ErrOutOfRange
	}
	e := t.entries[seq]
	e.Data = append([]byte(nil), e.Data...)
	return e, nil
}

// verifyEntry re-checks one stored block against its predecessor.
func verifyEntry(prev [sha1.Size]byte, e *Entry) error {
	if crc32.ChecksumIEEE(e.Data) != e.CRC {
		return &CorruptionError{Seq: e.Seq, Reason: "payload checksum mismatch"}
	}
	if chainHash(prev, e.Seq, e.Kind, e.CRC, e.Data) != e.Hash {
		return &CorruptionError{Seq: e.Seq, Reason: "hash chain mismatch"}
	}
	return nil
}

// Verify walks the whole trace and returns nil if every block is intact,
// or a *CorruptionError locating the first damaged block.
func (t *Trace) Verify() error {
	return t.verifyPrefix(uint64(len(t.entries)))
}

// verifyPrefix checks blocks [0, n). Block sequence numbers must also be
// contiguous and ordered, so a damaged Seq field is caught as well.
func (t *Trace) verifyPrefix(n uint64) error {
	if n > uint64(len(t.entries)) {
		n = uint64(len(t.entries))
	}
	var prev [sha1.Size]byte
	for i := uint64(0); i < n; i++ {
		e := &t.entries[i]
		if e.Seq != i {
			return &CorruptionError{Seq: i, Reason: fmt.Sprintf("sequence number mismatch: stored %d, expected %d", e.Seq, i)}
		}
		if err := verifyEntry(prev, e); err != nil {
			return err
		}
		prev = e.Hash
	}
	return nil
}

// Branch forks the trace for exploratory debugging. The branch shares the
// existing immutable blocks but appends independently: recording on the
// branch never modifies the original trace, and vice versa.
func (t *Trace) Branch() *Trace {
	entries := make([]Entry, len(t.entries))
	copy(entries, t.entries)
	return &Trace{entries: entries}
}

// EqualBytes reports whether both traces contain identical blocks,
// comparing every payload byte-for-byte.
func (t *Trace) EqualBytes(o *Trace) bool {
	if len(t.entries) != len(o.entries) {
		return false
	}
	for i := range t.entries {
		a, b := &t.entries[i], &o.entries[i]
		if a.Seq != b.Seq || a.Kind != b.Kind || a.CRC != b.CRC ||
			a.Hash != b.Hash || !bytes.Equal(a.Data, b.Data) {
			return false
		}
	}
	return true
}
