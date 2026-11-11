package q212

// insertPending adds data to the sorted, gap-bearing pending list. The caller
// guarantees overlapping bytes were already verified identical, so overlaps
// are discarded from the newcomer and adjacent ranges are fused.
func (s *stream) insertPending(start uint64, data []byte) {
	frag := fragment{data: append([]byte(nil), data...), origin: start}

	pos := len(s.pending)
	for i, seg := range s.pending {
		if seg.start >= start {
			pos = i
			break
		}
	}

	// Trim the newcomer's front where the predecessor already covers it.
	if pos > 0 {
		pred := s.pending[pos-1]
		if pred.end() > start {
			drop := int(pred.end() - start)
			if drop >= len(frag.data) {
				frag.data = nil
			} else {
				frag = trimFragmentFront(frag, drop)
				start += uint64(drop)
			}
		}
	}

	if len(frag.data) > 0 {
		s.pending = append(s.pending, segment{})
		copy(s.pending[pos+1:], s.pending[pos:])
		s.pending[pos] = segment{start: start, frags: []fragment{frag}}
		pos++
	}

	s.compact()
}

// compact fuses every pair of stored segments that touch or overlap. Because
// conflictPending already rejected disagreeing overlaps, dropped bytes are
// known-identical duplicates.
func (s *stream) compact() {
	if len(s.pending) < 2 {
		return
	}
	out := s.pending[:1]
	for i := 1; i < len(s.pending); i++ {
		prev := &out[len(out)-1]
		cur := s.pending[i]

		if cur.start > prev.end() {
			out = append(out, cur)
			continue
		}

		// Drop the fully covered case.
		if cur.end() <= prev.end() {
			continue
		}

		drop := int(prev.end() - cur.start)
		for _, f := range cur.frags {
			if drop == 0 {
				prev.frags = append(prev.frags, f)
				continue
			}
			if drop >= len(f.data) {
				drop -= len(f.data)
				continue
			}
			prev.frags = append(prev.frags, trimFragmentFront(f, drop))
			drop = 0
		}
	}
	s.pending = out
}

// trimFragmentFront drops n leading bytes while preserving origin metadata.
func trimFragmentFront(f fragment, n int) fragment {
	return fragment{data: f.data[n:], origin: f.origin + uint64(n)}
}
