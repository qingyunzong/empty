package imgdiff

// cursor walks a normalized extent list, exposing content and layout per
// offset. Beyond the image size everything is a hole (reads as zeros).
type cursor struct {
	exts []Extent
	idx  int
	pos  uint64 // absolute offset of cursor within current extent
	size uint64
}

func newCursor(img *Image) *cursor {
	return &cursor{exts: img.Normalized(), size: img.Size}
}

// kindAt returns the layout kind valid at c.pos.
func (c *cursor) kindAt() Kind {
	if c.idx >= len(c.exts) {
		return Hole
	}
	return c.exts[c.idx].Kind
}

// remain returns the remaining length of the current run (extent tail),
// or +inf (maxUint64) past the end of the extent list.
func (c *cursor) remain() uint64 {
	if c.idx >= len(c.exts) {
		return ^uint64(0)
	}
	return c.exts[c.idx].End() - c.pos
}

// advance moves the cursor forward by n (n <= remain()).
func (c *cursor) advance(n uint64) {
	c.pos += n
	for c.idx < len(c.exts) && c.pos >= c.exts[c.idx].End() {
		c.idx++
	}
}

// bytes returns the content of the current run segment [pos, pos+n):
// the extent's bytes, or zeros for a hole.
func (c *cursor) bytes(n uint64) []byte {
	if c.idx >= len(c.exts) || c.exts[c.idx].Kind == Hole {
		return make([]byte, n)
	}
	e := c.exts[c.idx]
	off := c.pos - e.Start
	return e.Data[off : off+n]
}

// contentRuns returns the differing sub-intervals (relative to the cursor
// positions) over the next n bytes. Holes read as zeros, so a hole and a
// zero-filled data extent are content-equal.
func contentRuns(a, b *cursor, n uint64) []Interval {
	if a.kindAt() == Hole && b.kindAt() == Hole {
		return nil
	}
	ba, bb := a.bytes(n), b.bytes(n)
	var out []Interval
	for i := uint64(0); i < n; i++ {
		if ba[i] == bb[i] {
			continue
		}
		if len(out) > 0 && out[len(out)-1].End == i {
			out[len(out)-1].End = i + 1
		} else {
			out = append(out, Interval{Start: i, End: i + 1})
		}
	}
	return out
}

// diff walks both images and emits maximal half-open intervals from the
// per-segment runs reported by runs.
func diff(a, b *Image, runs func(ca, cb *cursor, n uint64) []Interval) []Interval {
	ca, cb := newCursor(a), newCursor(b)
	limit := a.Size
	if b.Size > limit {
		limit = b.Size
	}
	var out []Interval
	pos := uint64(0)
	for pos < limit {
		n := ca.remain()
		if r := cb.remain(); r < n {
			n = r
		}
		if r := limit - pos; r < n {
			n = r
		}
		for _, iv := range runs(ca, cb, n) {
			start, end := pos+iv.Start, pos+iv.End
			if len(out) > 0 && out[len(out)-1].End == start {
				out[len(out)-1].End = end
			} else {
				out = append(out, Interval{Start: start, End: end})
			}
		}
		ca.advance(n)
		cb.advance(n)
		pos += n
	}
	return out
}

// ContentDiff returns the maximal half-open intervals over
// [0, max(sizeA, sizeB)) where the byte content of a and b differs. Holes
// read as zeros; beyond an image's size everything reads as zeros.
func ContentDiff(a, b *Image) ([]Interval, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if err := b.Validate(); err != nil {
		return nil, err
	}
	return diff(a, b, contentRuns), nil
}

// LayoutDiff returns the maximal half-open intervals over
// [0, max(sizeA, sizeB)) where the data/hole layout of a and b differs. A
// zero-filled data block and a hole are content-equal but layout-different.
func LayoutDiff(a, b *Image) ([]Interval, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if err := b.Validate(); err != nil {
		return nil, err
	}
	return diff(a, b, func(ca, cb *cursor, n uint64) []Interval {
		if ca.kindAt() != cb.kindAt() {
			return []Interval{{Start: 0, End: n}}
		}
		return nil
	}), nil
}
