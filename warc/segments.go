package warc

import (
	"fmt"
	"sort"
)

// segmentGroup is the origin (segment 1) plus its continuations.
type segmentGroup struct {
	origin        *Record
	continuations []*Record
}

// groupSegments validates segmentation headers and groups continuations
// with their origin records.
func groupSegments(records map[string]*Record) (map[string]*segmentGroup, error) {
	groups := make(map[string]*segmentGroup)
	for _, r := range records {
		if !r.segmented() {
			continue
		}
		switch {
		case r.SegmentNumber == 1:
			g := groups[r.ID]
			if g == nil {
				g = &segmentGroup{}
				groups[r.ID] = g
			}
			if g.origin != nil {
				return nil, fmt.Errorf("%w: duplicate segment 1 for origin %q", ErrSegmentGap, r.ID)
			}
			g.origin = r
		case r.SegmentNumber >= 2:
			if r.Type != TypeContinuation {
				return nil, fmt.Errorf("%w: record %q has segment number %d but type %q",
					ErrSegmentGap, r.ID, r.SegmentNumber, r.Type)
			}
			if r.SegmentOriginID == "" {
				return nil, fmt.Errorf("%w: continuation %q has no segment origin id",
					ErrMissingSegmentOrigin, r.ID)
			}
			g := groups[r.SegmentOriginID]
			if g == nil {
				g = &segmentGroup{}
				groups[r.SegmentOriginID] = g
			}
			g.continuations = append(g.continuations, r)
		default:
			return nil, fmt.Errorf("%w: continuation %q has invalid segment number %d",
				ErrSegmentGap, r.ID, r.SegmentNumber)
		}
	}
	for id, g := range groups {
		if g.origin == nil {
			return nil, fmt.Errorf("%w: no segment 1 record for origin %q", ErrMissingSegmentOrigin, id)
		}
	}
	return groups, nil
}

// reassemble concatenates the group contents in segment-number order and
// verifies contiguity and the declared total length. It returns nil for
// a lone segment-1 record that declares no total length (an unsegmented
// record that merely carries a segment number).
func (g *segmentGroup) reassemble() ([]byte, error) {
	segs := make([]*Record, 0, len(g.continuations)+1)
	segs = append(segs, g.origin)
	segs = append(segs, g.continuations...)
	sort.Slice(segs, func(i, j int) bool { return segs[i].SegmentNumber < segs[j].SegmentNumber })

	var out []byte
	for i, s := range segs {
		if s.SegmentNumber != i+1 {
			return nil, fmt.Errorf("%w: origin %q expected segment %d, found %d (record %q)",
				ErrSegmentGap, g.origin.ID, i+1, s.SegmentNumber, s.ID)
		}
		out = append(out, s.Content...)
	}

	last := segs[len(segs)-1]
	if len(segs) == 1 && last.SegmentTotalLength == 0 {
		return nil, nil
	}
	if last.SegmentTotalLength <= 0 {
		return nil, fmt.Errorf("%w: last segment %q of origin %q declares no total length",
			ErrSegmentTotalLength, last.ID, g.origin.ID)
	}
	if int64(len(out)) != last.SegmentTotalLength {
		return nil, fmt.Errorf("%w: origin %q reassembled to %d bytes, declared %d",
			ErrSegmentTotalLength, g.origin.ID, len(out), last.SegmentTotalLength)
	}
	return out, nil
}
