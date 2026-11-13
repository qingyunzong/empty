package dataeng

import (
	"errors"
	"fmt"
	"slices"
)

// Sentinel errors returned for invalid or contradictory input. Overlapping
// content with different bytes is a normal ledger outcome, not an error: it is
// reported through Outcome.Conflicts and Snapshot.Conflicts.
var (
	ErrInvalidSegment     = errors.New("dataeng: invalid segment")
	ErrInvalidSuffix      = errors.New("dataeng: invalid suffix")
	ErrInvalidTotal       = errors.New("dataeng: invalid total size")
	ErrRangeBeyondTotal   = errors.New("dataeng: segment lies beyond known total size")
	ErrTotalConflict      = errors.New("dataeng: total size conflicts with covered content")
	ErrSuffixExceedsTotal = errors.New("dataeng: suffix is longer than total size")
	ErrTotalAlreadyKnown  = errors.New("dataeng: total size is already known")
)

// Segment is a piece of content covering the half-open byte range
// [Start, End). Data must contain exactly End-Start bytes. Source identifies
// where the bytes came from; an empty Source is allowed but is less useful for
// conflict reporting.
type Segment struct {
	Start  int64
	End    int64
	Data   []byte
	Source string
}

// Suffix is a range relative to the end of the content: it covers the last
// Length bytes. A suffix is held pending until the total content length is
// known, then it becomes [Total-Length, Total).
type Suffix struct {
	Length int64
	Data   []byte
	Source string
}

// Conflict describes a byte run where an incoming segment disagreed with
// content that was already covered. The incoming segment is rejected as a
// whole, while the existing content and both sources are retained.
type Conflict struct {
	Start           int64
	End             int64
	ExistingSources []string
	IncomingSource  string
}

// Range is a canonical covered interval. It contains the bytes for
// [Start, End), and Sources is the sorted set of all sources that contributed
// identical bytes to the interval.
type Range struct {
	Start   int64
	End     int64
	Data    []byte
	Sources []string
}

// Hole is an explicitly uncovered interval. Holes never contain bytes, and no
// zero filling is performed.
type Hole struct {
	Start int64
	End   int64
}

// Outcome reports what happened to one AddSegment or AddSuffix call. Accepted
// is false when the whole input range was rejected because of a byte conflict.
// Pending is true when a suffix was accepted but is waiting for the total
// length. Conflicts contains the mismatch runs found in the incoming range.
type Outcome struct {
	Accepted  bool
	Pending   bool
	Conflicts []Conflict
}

// Snapshot is an immutable view of the ledger. All byte slices are copies and
// may be modified by the caller.
type Snapshot struct {
	TotalSize       int64
	TotalKnown      bool
	Ranges          []Range
	Holes           []Hole
	Conflicts       []Conflict
	PendingSuffixes []Suffix
	Complete        bool
}

// Ledger accumulates content ranges without transferring any data. It is not
// safe for concurrent use.
type Ledger struct {
	total      int64
	totalKnown bool
	spans      []span
	provenance []provenanceSpan
	conflicts  []Conflict
	pending    []Suffix
}

type span struct {
	start   int64
	end     int64
	data    []byte
	sources []string
}

type provenanceSpan struct {
	start  int64
	end    int64
	source string
}

// NewLedger returns an empty ledger with an unknown total length.
func NewLedger() *Ledger {
	return &Ledger{}
}

// AddSegment adds one half-open content range. The operation is transactional:
// if any overlapping byte differs, the entire segment is rejected and the
// conflicting runs are recorded. Identical overlaps and adjacent ranges are
// merged, with their source sets combined.
//
// A segment extending past a known total length is rejected with
// ErrRangeBeyondTotal. Malformed input is rejected with ErrInvalidSegment.
func (l *Ledger) AddSegment(seg Segment) (Outcome, error) {
	if err := validateSegment(seg); err != nil {
		return Outcome{}, err
	}
	return l.add(seg.Start, seg.End, seg.Data, seg.Source)
}

// AddSuffix registers a range measured from the end of the content. While the
// total length is unknown the suffix remains pending and covers nothing. Once
// the total becomes known it is materialized and merged or rejected exactly
// like a normal segment.
//
// If the total length is already known, the suffix is materialized immediately.
// A suffix longer than the known total is rejected with
// ErrSuffixExceedsTotal.
func (l *Ledger) AddSuffix(s Suffix) (Outcome, error) {
	if err := validateSuffix(s); err != nil {
		return Outcome{}, err
	}
	if !l.totalKnown {
		l.pending = append(l.pending, Suffix{
			Length: s.Length,
			Data:   slices.Clone(s.Data),
			Source: s.Source,
		})
		return Outcome{Accepted: true, Pending: true}, nil
	}
	if s.Length > l.total {
		return Outcome{}, fmt.Errorf("%w: suffix length %d, total %d",
			ErrSuffixExceedsTotal, s.Length, l.total)
	}
	return l.add(l.total-s.Length, l.total, s.Data, s.Source)
}

// SetTotalSize fixes the total content length. It is atomic: if the total
// contradicts content that is already covered, or a pending suffix would be
// longer than the total, the ledger is left unchanged and an error is
// returned.
//
// A total that is smaller than any covered byte is ErrTotalConflict. A total
// smaller than a pending suffix is ErrSuffixExceedsTotal. Successfully setting
// the total materializes all pending suffixes in registration order; byte
// conflicts discovered while doing so are recorded in Snapshot.Conflicts.
func (l *Ledger) SetTotalSize(total int64) error {
	if total < 0 {
		return fmt.Errorf("%w: %d", ErrInvalidTotal, total)
	}
	if l.totalKnown {
		if l.total == total {
			return nil
		}
		return fmt.Errorf("%w: already %d, got %d", ErrTotalAlreadyKnown, l.total, total)
	}
	if len(l.spans) > 0 && l.spans[len(l.spans)-1].end > total {
		return fmt.Errorf("%w: covered through %d, got total %d",
			ErrTotalConflict, l.spans[len(l.spans)-1].end, total)
	}
	for _, s := range l.pending {
		if s.Length > total {
			return fmt.Errorf("%w: suffix length %d, got total %d",
				ErrSuffixExceedsTotal, s.Length, total)
		}
	}

	l.total = total
	l.totalKnown = true
	pending := l.pending
	l.pending = nil
	for _, s := range pending {
		_, _ = l.add(total-s.Length, total, s.Data, s.Source)
	}
	return nil
}

// Snapshot returns a copy of the current ledger state.
//
// Ranges are sorted, disjoint, non-adjacent, and hold actual bytes. Holes are
// gaps within the known domain: [0, TotalSize) when the total is known, or
// [0, last covered byte) while the total is unknown. An unknown trailing
// region is therefore not reported as a hole. Complete is true only when the
// total is known, [0, TotalSize) is fully covered, and no conflict has ever
// been recorded.
func (l *Ledger) Snapshot() Snapshot {
	snap := Snapshot{
		TotalSize:  l.total,
		TotalKnown: l.totalKnown,
	}

	for _, s := range l.spans {
		snap.Ranges = append(snap.Ranges, Range{
			Start:   s.start,
			End:     s.end,
			Data:    slices.Clone(s.data),
			Sources: slices.Clone(s.sources),
		})
	}
	for _, c := range l.conflicts {
		snap.Conflicts = append(snap.Conflicts, Conflict{
			Start:           c.Start,
			End:             c.End,
			ExistingSources: slices.Clone(c.ExistingSources),
			IncomingSource:  c.IncomingSource,
		})
	}
	for _, s := range l.pending {
		snap.PendingSuffixes = append(snap.PendingSuffixes, Suffix{
			Length: s.Length,
			Data:   slices.Clone(s.Data),
			Source: s.Source,
		})
	}

	domainEnd := int64(0)
	if l.totalKnown {
		domainEnd = l.total
	} else if len(l.spans) > 0 {
		domainEnd = l.spans[len(l.spans)-1].end
	}
	cursor := int64(0)
	for _, s := range l.spans {
		if s.start > cursor {
			snap.Holes = append(snap.Holes, Hole{Start: cursor, End: s.start})
		}
		if s.end > cursor {
			cursor = s.end
		}
	}
	if l.totalKnown && cursor < domainEnd {
		snap.Holes = append(snap.Holes, Hole{Start: cursor, End: domainEnd})
	}

	snap.Complete = l.totalKnown &&
		len(l.conflicts) == 0 &&
		(l.total == 0 ||
			(len(l.spans) == 1 && l.spans[0].start == 0 && l.spans[0].end == l.total))
	return snap
}

func (l *Ledger) add(start, end int64, data []byte, source string) (Outcome, error) {
	if end == start {
		return Outcome{Accepted: true}, nil
	}
	if l.totalKnown && end > l.total {
		return Outcome{}, fmt.Errorf("%w: range [%d,%d), total %d",
			ErrRangeBeyondTotal, start, end, l.total)
	}

	conflicts := l.findConflicts(start, end, data, source)
	if len(conflicts) > 0 {
		l.conflicts = append(l.conflicts, conflicts...)
		return Outcome{Accepted: false, Conflicts: conflicts}, nil
	}

	l.merge(start, end, data, source)
	l.provenance = append(l.provenance, provenanceSpan{start: start, end: end, source: source})
	return Outcome{Accepted: true}, nil
}

func (l *Ledger) findConflicts(start, end int64, data []byte, source string) []Conflict {
	var conflicts []Conflict
	for _, s := range l.spans {
		if s.end <= start || s.start >= end {
			continue
		}
		overlapStart := max(start, s.start)
		overlapEnd := min(end, s.end)
		runStart := int64(-1)
		for pos := overlapStart; pos < overlapEnd; pos++ {
			if s.data[pos-s.start] != data[pos-start] {
				if runStart < 0 {
					runStart = pos
				}
				continue
			}
			if runStart >= 0 {
				conflicts = append(conflicts, Conflict{
					Start:           runStart,
					End:             pos,
					ExistingSources: l.sourcesFor(runStart, pos),
					IncomingSource:  source,
				})
				runStart = -1
			}
		}
		if runStart >= 0 {
			conflicts = append(conflicts, Conflict{
				Start:           runStart,
				End:             overlapEnd,
				ExistingSources: l.sourcesFor(runStart, overlapEnd),
				IncomingSource:  source,
			})
		}
	}
	return conflicts
}

func (l *Ledger) sourcesFor(start, end int64) []string {
	var sources []string
	for _, p := range l.provenance {
		if p.end <= start || p.start >= end {
			continue
		}
		sources = append(sources, p.source)
	}
	slices.Sort(sources)
	return slices.Compact(sources)
}

func (l *Ledger) merge(start, end int64, data []byte, source string) {
	merged := span{
		start:   start,
		end:     end,
		data:    slices.Clone(data),
		sources: []string{source},
	}

	kept := make([]span, 0, len(l.spans)+1)
	i := 0
	for i < len(l.spans) && l.spans[i].end < start {
		kept = append(kept, l.spans[i])
		i++
	}
	for i < len(l.spans) && l.spans[i].start <= merged.end {
		merged = mergeSpans(merged, l.spans[i])
		i++
	}
	kept = append(kept, merged)
	kept = append(kept, l.spans[i:]...)
	l.spans = kept
}

func mergeSpans(a, b span) span {
	start := min(a.start, b.start)
	end := max(a.end, b.end)
	data := make([]byte, end-start)
	copy(data[a.start-start:], a.data)
	copy(data[b.start-start:], b.data)

	sources := make([]string, 0, len(a.sources)+len(b.sources))
	sources = append(sources, a.sources...)
	sources = append(sources, b.sources...)
	slices.Sort(sources)
	sources = slices.Compact(sources)
	return span{start: start, end: end, data: data, sources: sources}
}

func validateSegment(seg Segment) error {
	if seg.Start < 0 {
		return fmt.Errorf("%w: negative start %d", ErrInvalidSegment, seg.Start)
	}
	if seg.End < seg.Start {
		return fmt.Errorf("%w: end %d precedes start %d", ErrInvalidSegment, seg.End, seg.Start)
	}
	if int64(len(seg.Data)) != seg.End-seg.Start {
		return fmt.Errorf("%w: data length %d does not match [%d,%d)",
			ErrInvalidSegment, len(seg.Data), seg.Start, seg.End)
	}
	return nil
}

func validateSuffix(s Suffix) error {
	if s.Length < 0 {
		return fmt.Errorf("%w: negative length %d", ErrInvalidSuffix, s.Length)
	}
	if int64(len(s.Data)) != s.Length {
		return fmt.Errorf("%w: data length %d does not match length %d",
			ErrInvalidSuffix, len(s.Data), s.Length)
	}
	return nil
}
