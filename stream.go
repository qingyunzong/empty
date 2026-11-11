package q212

type segment struct {
	start uint64
	frags []fragment
}

// fragment is a contiguous byte range inside a buffered segment plus the
// starting offset of the packet that originally supplied it.
type fragment struct {
	data   []byte
	origin uint64
}

func (seg segment) end() uint64 {
	n := 0
	for _, f := range seg.frags {
		n += len(f.data)
	}
	return seg.start + uint64(n)
}

func (seg segment) byteAt(offset uint64) (byte, uint64) {
	cursor := seg.start
	for _, f := range seg.frags {
		next := cursor + uint64(len(f.data))
		if offset < next {
			return f.data[offset-cursor], f.origin
		}
		cursor = next
	}
	return 0, seg.start
}

// marker remembers which delivered packet produced a byte range, so a later
// conflict can name both packets involved.
type marker struct {
	start  uint64
	origin uint64
}

// history is a bounded ring of the most recently delivered bytes plus the
// packet markers covering the retained suffix.
type history struct {
	ring    []byte
	cap     int
	base    uint64 // absolute offset of the logical ring start
	written int    // valid bytes before the ring first fills up
	marks   []marker
}

func newHistory(capBytes int) *history {
	return &history{ring: make([]byte, capBytes), cap: capBytes}
}

func (h *history) write(data []byte, origin, startOffset uint64) {
	h.marks = append(h.marks, marker{start: startOffset, origin: origin})
	for _, b := range data {
		if h.written == h.cap {
			h.ring[h.base%uint64(h.cap)] = b
			h.base++
			continue
		}
		h.ring[(h.base+uint64(h.written))%uint64(h.cap)] = b
		h.written++
	}
	h.pruneMarks()
}

func (h *history) pruneMarks() {
	for len(h.marks) > 1 && h.marks[1].start <= h.base {
		h.marks = h.marks[1:]
	}
}

func (h *history) at(offset uint64) byte {
	return h.ring[offset%uint64(h.cap)]
}

func (h *history) contains(offset uint64) bool {
	if h.written == 0 {
		return false
	}
	end := h.base + uint64(h.written)
	return offset >= h.base && offset < end
}

func (h *history) originOf(offset uint64) uint64 {
	origin := h.marks[0].origin
	for _, m := range h.marks {
		if m.start <= offset {
			origin = m.origin
		} else {
			break
		}
	}
	return origin
}

// compare verifies data at startOffset against retained delivered bytes.
// Evicted bytes cannot be checked and are skipped. The first disagreement
// produces a Conflict naming both originating packets.
func (h *history) compare(dir Direction, startOffset uint64, data []byte) *Conflict {
	for i, b := range data {
		offset := startOffset + uint64(i)
		if !h.contains(offset) {
			continue
		}
		got := h.at(offset)
		if got != b {
			return &Conflict{
				Direction:  dir,
				At:         offset,
				FirstOff:   h.originOf(offset),
				SecondOff:  startOffset,
				FirstByte:  got,
				SecondByte: b,
			}
		}
	}
	return nil
}

type stream struct {
	initialSeq uint32
	pending    []segment
	delivered  uint64
	haveFin    bool
	finOffset  int64
	closed     bool
	history    *history
}

func newStream(initialSeq uint32, historyBytes int) *stream {
	return &stream{
		initialSeq: initialSeq,
		history:    newHistory(historyBytes),
	}
}

func (s *stream) pendingTotal() int {
	total := 0
	for _, seg := range s.pending {
		for _, f := range seg.frags {
			total += len(f.data)
		}
	}
	return total
}

// pendingAfterDrainTotal counts bytes that would remain buffered once every
// contiguous prefix segment is delivered. Those are the bytes genuinely held
// in holes; prefix bytes are delivered immediately and never count against
// the cap.
func (s *stream) pendingAfterDrainTotal() int {
	total := s.pendingTotal()
	cursor := s.delivered
	for _, seg := range s.pending {
		if seg.start != cursor {
			break
		}
		n := int(seg.end() - seg.start)
		total -= n
		cursor = seg.end()
	}
	return total
}

// conflictPending checks fresh data against buffered-but-undelivered segments.
// Every overlapping byte must be identical.
func (s *stream) conflictPending(dir Direction, start uint64, data []byte) *Conflict {
	end := start + uint64(len(data))
	for _, seg := range s.pending {
		lo := maxUint64(start, seg.start)
		hi := minUint64(end, seg.end())
		for off := lo; off < hi; off++ {
			got, origin := seg.byteAt(off)
			want := data[off-start]
			if got != want {
				return &Conflict{
					Direction:  dir,
					At:         off,
					FirstOff:   origin,
					SecondOff:  start,
					FirstByte:  got,
					SecondByte: want,
				}
			}
		}
	}
	return nil
}

// snapshot captures the pending list so a backpressure rejection can restore
// the exact pre-packet state.
func (s *stream) snapshot() []segment {
	cp := make([]segment, len(s.pending))
	copy(cp, s.pending)
	return cp
}

func (s *stream) restore(saved []segment) {
	s.pending = saved
}

// drain delivers every buffered segment that extends the contiguous prefix,
// then closes the stream if a FIN with no preceding hole has been reached.
func (s *stream) drain() []byte {
	out := []byte{}
	for len(s.pending) > 0 && s.pending[0].start == s.delivered {
		seg := s.pending[0]
		s.pending = s.pending[1:]
		for _, f := range seg.frags {
			s.history.write(f.data, f.origin, s.delivered)
			s.delivered += uint64(len(f.data))
			out = append(out, f.data...)
		}
	}
	if !s.closed && s.haveFin && s.finOffset == int64(s.delivered) {
		s.closed = true
	}
	return out
}
