package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
)

// Op is the operation carried by a Record: either a write (OpPut) or a
// delete (OpDelete).
type Op int

const (
	OpPut Op = iota
	OpDelete
)

func (o Op) valid() bool { return o == OpPut || o == OpDelete }

// Record is a single sorted log record in a segment.
type Record struct {
	Key     string
	Seq     uint64
	Op      Op
	Payload []byte
}

// Entry is the merged state of one key in the output. A tombstone (the
// key's last record is a delete beyond the watermark) has Op == OpDelete
// and a nil Payload.
type Entry struct {
	Key     string
	Seq     uint64
	Op      Op
	Payload []byte
}

var (
	// ErrMissingWatermark is returned when the caller does not supply a
	// watermark; the whole merge fails.
	ErrMissingWatermark = errors.New("dataeng: watermark is required")
	// ErrUnsortedSegment is returned when a segment is not ordered by
	// (Key, Seq) ascending; the whole merge fails with no partial result.
	ErrUnsortedSegment = errors.New("dataeng: segment not sorted by key then sequence")
)

// Merge combines multiple sorted record segments into one output ordered by
// key ascending.
//
// Every segment must be sorted by key ascending, and by sequence ascending
// within the same key, otherwise the whole merge fails. A nil watermark
// also fails the whole merge.
//
// Per key, records with the same sequence are deduplicated when their
// payloads are identical; differing payloads conflict and the key leaves
// the output. A key whose sequence numbers have a gap between its minimum
// and maximum is paused and leaves the output. Other keys are unaffected
// in both cases.
//
// A delete removes the key from the output only when it is the key's last
// record and its sequence is not greater than the watermark; a delete
// beyond the watermark stays in the output as a tombstone. A later write
// with a higher sequence makes the key reappear with the new payload.
func Merge(segments [][]Record, watermark *uint64) ([]Entry, error) {
	if watermark == nil {
		return nil, ErrMissingWatermark
	}
	for i, seg := range segments {
		if !sorted(seg) {
			return nil, fmt.Errorf("%w: segment %d", ErrUnsortedSegment, i)
		}
	}

	byKey := make(map[string][]Record)
	for _, seg := range segments {
		for _, r := range seg {
			if !r.Op.valid() {
				return nil, fmt.Errorf("dataeng: invalid op %d for key %q seq %d", r.Op, r.Key, r.Seq)
			}
			byKey[r.Key] = append(byKey[r.Key], r)
		}
	}

	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]Entry, 0, len(keys))
	for _, k := range keys {
		if e, ok := resolveKey(k, byKey[k], *watermark); ok {
			out = append(out, e)
		}
	}
	return out, nil
}

// sorted reports whether seg is ordered by (Key, Seq) non-decreasing.
func sorted(seg []Record) bool {
	for i := 1; i < len(seg); i++ {
		prev, cur := seg[i-1], seg[i]
		if cur.Key < prev.Key || (cur.Key == prev.Key && cur.Seq < prev.Seq) {
			return false
		}
	}
	return true
}

// resolveKey folds all records of one key into its final entry. The second
// result is false when the key leaves the output (conflict, sequence gap,
// or deleted at or below the watermark).
func resolveKey(key string, recs []Record, watermark uint64) (Entry, bool) {
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].Seq < recs[j].Seq })

	deduped := make([]Record, 0, len(recs))
	for i := 0; i < len(recs); {
		j := i + 1
		for j < len(recs) && recs[j].Seq == recs[i].Seq {
			if !bytes.Equal(recs[j].Payload, recs[i].Payload) {
				return Entry{}, false
			}
			j++
		}
		deduped = append(deduped, recs[i])
		i = j
	}

	for i := 1; i < len(deduped); i++ {
		if deduped[i].Seq != deduped[i-1].Seq+1 {
			return Entry{}, false
		}
	}

	last := deduped[len(deduped)-1]
	if last.Op == OpDelete {
		if last.Seq <= watermark {
			return Entry{}, false
		}
		return Entry{Key: key, Seq: last.Seq, Op: OpDelete}, true
	}

	payload := make([]byte, len(last.Payload))
	copy(payload, last.Payload)
	return Entry{Key: key, Seq: last.Seq, Op: OpPut, Payload: payload}, true
}
