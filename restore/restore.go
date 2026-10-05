// Package restore reconstructs a replicated log from a checkpoint version
// and multiple overlapping log segments.
//
// Merge rules:
//   - entries with the same sequence number and identical content are
//     deduplicated;
//   - entries with the same sequence number but different content are
//     rejected as a conflict;
//   - only the continuous prefix of sequence numbers right after the
//     checkpoint is applied; the first missing sequence number and the
//     segments that resume after it are reported as a gap.
package restore

import (
	"fmt"
	"strings"
)

// Entry is a single log record.
type Entry struct {
	Seq  int
	Data string
}

// Segment is a named, possibly overlapping slice of the log.
type Segment struct {
	Name    string
	Entries []Entry
}

// AppliedEntry is an applied entry together with its source segment.
type AppliedEntry struct {
	Entry
	Source string
}

// Gap describes the first sequence number missing after the applied prefix.
type Gap struct {
	Seq int
	// Sources lists the segments that contain entries beyond the gap,
	// i.e. the segments proving the log resumes later.
	Sources []string
}

func (g Gap) String() string {
	if len(g.Sources) == 0 {
		return fmt.Sprintf("first missing seq %d (no segment provides it)", g.Seq)
	}
	return fmt.Sprintf("first missing seq %d (log resumes in segments: %s)",
		g.Seq, strings.Join(g.Sources, ", "))
}

// ConflictError reports two segments disagreeing on one sequence number.
type ConflictError struct {
	Seq           int
	First, Second string // segment names
	A, B          string // conflicting contents
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflict at seq %d: segment %q has %q, segment %q has %q",
		e.Seq, e.First, e.A, e.Second, e.B)
}

// Result is the outcome of a Restore.
type Result struct {
	Checkpoint int
	Applied    []AppliedEntry
	// Gap is non-nil when entries exist beyond the first missing sequence
	// number, i.e. the merged log is not continuous from checkpoint+1.
	Gap *Gap
}

// Restore merges the segments, deduplicates identical entries, rejects
// conflicting ones, and applies only the continuous prefix after checkpoint.
// Entries at or below the checkpoint are ignored.
func Restore(checkpoint int, segments []Segment) (Result, error) {
	type owner struct {
		data string
		seg  string
	}
	merged := make(map[int]owner)
	for _, seg := range segments {
		for _, e := range seg.Entries {
			if e.Seq <= checkpoint {
				continue
			}
			prev, ok := merged[e.Seq]
			if ok {
				if prev.data != e.Data {
					return Result{}, &ConflictError{
						Seq: e.Seq, First: prev.seg, Second: seg.Name,
						A: prev.data, B: e.Data,
					}
				}
				continue // duplicate: same seq, same content
			}
			merged[e.Seq] = owner{data: e.Data, seg: seg.Name}
		}
	}

	res := Result{Checkpoint: checkpoint}
	seq := checkpoint + 1
	for {
		o, ok := merged[seq]
		if !ok {
			break
		}
		res.Applied = append(res.Applied, AppliedEntry{
			Entry:  Entry{Seq: seq, Data: o.data},
			Source: o.seg,
		})
		seq++
	}

	// seq is now the first missing sequence number. It is a real gap only
	// if some segment resumes the log beyond it.
	if len(merged) > len(res.Applied) {
		gap := Gap{Seq: seq}
		seen := make(map[string]bool)
		for _, seg := range segments {
			for _, e := range seg.Entries {
				if e.Seq > seq && !seen[seg.Name] {
					seen[seg.Name] = true
					gap.Sources = append(gap.Sources, seg.Name)
				}
			}
		}
		res.Gap = &gap
	}
	return res, nil
}
