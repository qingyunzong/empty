package dataeng

import (
	"fmt"
	"sort"
)

type segmentKind uint8

const (
	segmentInterval segmentKind = iota
	segmentPending
)

type coverageSegment struct {
	lo, hi uint32
	kind   segmentKind
}

// Verify checks the exactness contract for res against r.
//
// It verifies that every interval's prefixes tile [Lo,Hi), that each
// interval and pending prefix is wholly inside r, that intervals and pending
// prefixes are disjoint, that completed intervals are maximal, and that no
// query code lies in an uncovered gap. The gap check decomposes gaps into
// quadtree nodes, so it does not enumerate the code domain.
func (d Domain) Verify(r Rect, res Result) error {
	if err := d.ValidateRect(r); err != nil {
		return err
	}
	if res.Complete && len(res.Pending) != 0 {
		return fmt.Errorf("dataeng: complete result has %d pending prefixes", len(res.Pending))
	}
	if !res.Complete && len(res.Pending) == 0 {
		return fmt.Errorf("dataeng: incomplete result has no pending prefixes")
	}

	var segments []coverageSegment
	var prevInterval *Interval
	for i := range res.Intervals {
		iv := &res.Intervals[i]
		if err := d.verifyInterval(r, iv, prevInterval); err != nil {
			return err
		}
		segments = append(segments, coverageSegment{lo: iv.Lo, hi: iv.Hi, kind: segmentInterval})
		prevInterval = iv
	}

	var prevPendingHi uint32
	havePending := false
	for _, n := range res.Pending {
		if !n.Valid() || n.Bits != d.Bits {
			return fmt.Errorf("dataeng: invalid pending prefix %+v", n)
		}
		lo, hi, ok := n.CodeRange()
		if !ok {
			return fmt.Errorf("dataeng: invalid pending prefix range %+v", n)
		}
		if havePending && lo < prevPendingHi {
			return fmt.Errorf("dataeng: pending prefixes overlap at code %d", lo)
		}
		rect, ok := n.CellRect()
		if !ok || !rectInside(rect, r) {
			return fmt.Errorf("dataeng: pending prefix %+v is not wholly inside the query", n)
		}
		segments = append(segments, coverageSegment{lo: lo, hi: hi, kind: segmentPending})
		prevPendingHi = hi
		havePending = true
	}

	sort.Slice(segments, func(i, j int) bool {
		return segments[i].lo < segments[j].lo
	})

	cursor := uint32(0)
	var prev coverageSegment
	for i, seg := range segments {
		if seg.lo < cursor {
			return fmt.Errorf("dataeng: coverage segments overlap at code %d", seg.lo)
		}
		if seg.lo > cursor {
			if err := d.verifyGapOutside(r, cursor, seg.lo); err != nil {
				return err
			}
		}
		if i > 0 && prev.hi == seg.lo {
			if prev.kind == segmentInterval || seg.kind == segmentInterval {
				return fmt.Errorf("dataeng: adjacent coverage at code %d was not merged", seg.lo)
			}
		}
		cursor = seg.hi
		prev = seg
	}
	if cursor < d.CodeCount() {
		if err := d.verifyGapOutside(r, cursor, d.CodeCount()); err != nil {
			return err
		}
	}
	return nil
}

func (d Domain) verifyInterval(r Rect, iv *Interval, prev *Interval) error {
	if iv.Lo >= iv.Hi {
		return fmt.Errorf("dataeng: interval [%d,%d) is empty or reversed", iv.Lo, iv.Hi)
	}
	if iv.Hi > d.CodeCount() {
		return fmt.Errorf("dataeng: interval [%d,%d) exceeds domain", iv.Lo, iv.Hi)
	}
	if prev != nil && iv.Lo < prev.Hi {
		return fmt.Errorf("dataeng: interval [%d,%d) overlaps previous [%d,%d)",
			iv.Lo, iv.Hi, prev.Lo, prev.Hi)
	}
	if prev != nil && iv.Lo == prev.Hi {
		return fmt.Errorf("dataeng: adjacent intervals %d..%d were not merged",
			prev.Lo, iv.Hi)
	}
	if len(iv.Prefixes) == 0 {
		return fmt.Errorf("dataeng: interval [%d,%d) has no prefix decomposition", iv.Lo, iv.Hi)
	}

	cursor := iv.Lo
	for _, n := range iv.Prefixes {
		if !n.Valid() || n.Bits != d.Bits {
			return fmt.Errorf("dataeng: invalid interval prefix %+v", n)
		}
		lo, hi, ok := n.CodeRange()
		if !ok {
			return fmt.Errorf("dataeng: invalid interval prefix range %+v", n)
		}
		if lo != cursor {
			return fmt.Errorf("dataeng: prefix %+v has range [%d,%d), want start %d",
				n, lo, hi, cursor)
		}
		if hi > iv.Hi {
			return fmt.Errorf("dataeng: prefix %+v overruns interval end %d", n, iv.Hi)
		}
		rect, ok := n.CellRect()
		if !ok || !rectInside(rect, r) {
			return fmt.Errorf("dataeng: interval prefix %+v is not wholly inside the query", n)
		}
		cursor = hi
	}
	if cursor != iv.Hi {
		return fmt.Errorf("dataeng: prefixes end at %d, interval ends at %d", cursor, iv.Hi)
	}
	return nil
}

func rectInside(inner, outer Rect) bool {
	return inner.MinX >= outer.MinX && inner.MaxX <= outer.MaxX &&
		inner.MinY >= outer.MinY && inner.MaxY <= outer.MaxY
}

func (d Domain) verifyGapOutside(r Rect, lo, hi uint32) error {
	for lo < hi {
		k := uint8(0)
		for k < d.Bits {
			next := uint32(1) << (2 * (k + 1))
			if lo&(next-1) == 0 && next <= hi-lo {
				k++
				continue
			}
			break
		}
		size := uint32(1) << (2 * k)
		n := Node{Bits: d.Bits, Depth: d.Bits - k, Prefix: lo}
		rect, ok := n.CellRect()
		if !ok {
			return fmt.Errorf("dataeng: failed to decompose gap at code %d", lo)
		}
		if rect.MinX <= r.MaxX && rect.MaxX >= r.MinX &&
			rect.MinY <= r.MaxY && rect.MaxY >= r.MinY {
			return fmt.Errorf(
				"dataeng: uncovered gap [%d,%d) contains query node %+v",
				lo, hi, n)
		}
		lo += size
	}
	return nil
}
