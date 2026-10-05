package ringlog

import (
	"encoding/binary"
	"hash/crc32"
	"io"
	"os"
)

// Open opens an existing ring file and recovers the last complete
// prefix of the frame stream:
//
//  1. Validate every page header (magic + CRC + index + bounds).
//     Pages with torn headers are treated as nonexistent.
//  2. Pick the newest non-empty valid page as the stream tail, then
//     walk backwards over contiguous (generation, index) predecessors
//     to find the stream start. Stale pages from older laps and pages
//     after a torn header are excluded by the generation check.
//  3. Replay frames forward from the first frame start in the stream,
//     stopping at the first torn or corrupt frame.
//
// The writer resumes at the end of the recovered prefix.
func Open(path string) (*Logger, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.Size() == 0 || st.Size()%PageSize != 0 || st.Size()/PageSize < 2 {
		f.Close()
		return nil, ErrInvalid
	}
	l := newLogger(f, uint32(st.Size()/PageSize))
	if err := l.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return l, nil
}

func (l *Logger) recover() error {
	n := int(l.numPages)
	gens := make([]uint32, n)
	plens := make([]uint32, n)
	firsts := make([]uint32, n)
	valid := make([]bool, n)
	anyValid := false
	var newestAny streamPos
	for i := 0; i < n; i++ {
		var hdr [pageHeaderSize]byte
		if _, err := l.f.ReadAt(hdr[:], int64(i)*PageSize); err != nil {
			return err
		}
		gen, idx, plen, first, ok := decodePageHeader(hdr[:])
		if !ok || idx != uint32(i) {
			continue
		}
		valid[i] = true
		gens[i], plens[i], firsts[i] = gen, plen, first
		if !anyValid || gen > newestAny.gen || (gen == newestAny.gen && uint32(i) > newestAny.idx) {
			newestAny = streamPos{gen: gen, idx: uint32(i)}
			anyValid = true
		}
	}

	// Stream tail: valid, non-empty page with the max (gen, idx).
	tail := -1
	for i := 0; i < n; i++ {
		if !valid[i] || plens[i] == 0 {
			continue
		}
		if tail < 0 || gens[i] > gens[tail] || (gens[i] == gens[tail] && i > tail) {
			tail = i
		}
	}
	if tail < 0 {
		// No payload anywhere: resume empty at the newest valid page.
		if anyValid {
			l.gen, l.idx = newestAny.gen, newestAny.idx
		}
		l.off, l.pageFirst = 0, noFrame
		l.committed = streamPos{gen: l.gen, idx: l.idx}
		l.oldest = l.committed
		return l.flushHeaderLocked()
	}

	// Walk back over contiguous predecessors. Crossing index 0 means
	// the previous lap, i.e. generation-1; anything else breaks the run.
	start := tail
	for {
		g := gens[start]
		var prevIdx int
		var prevGen uint32
		if start == 0 {
			if g <= initialGen {
				break
			}
			prevIdx, prevGen = n-1, g-1
		} else {
			prevIdx, prevGen = start-1, g
		}
		if !valid[prevIdx] || gens[prevIdx] != prevGen {
			break
		}
		start = prevIdx
	}

	var pages []int
	for i := start; ; {
		pages = append(pages, i)
		if i == tail {
			break
		}
		i++
		if i == n {
			i = 0
		}
	}

	// Bytes before the first frame start belong to a frame whose head
	// is lost; skip to the first page that begins a frame.
	si := 0
	for si < len(pages) {
		fo := firsts[pages[si]]
		if fo != noFrame && fo < plens[pages[si]] {
			break
		}
		si++
	}

	// If nothing parses, reclaim the ring from the stream start.
	resume := streamPos{gen: gens[start], idx: uint32(start)}
	if si < len(pages) {
		s := &pageStream{
			f:     l.f,
			pages: pages[si:],
			gens:  gens,
			plens: plens,
			off:   firsts[pages[si]],
		}
		maxFrame := uint32(n) * pagePayloadCap
		for {
			pos := s.pos()
			var hdr [frameHeaderSize]byte
			if _, err := io.ReadFull(s, hdr[:]); err != nil {
				break // torn frame tail
			}
			flen := binary.LittleEndian.Uint32(hdr[0:4])
			fcrc := binary.LittleEndian.Uint32(hdr[4:8])
			if flen > maxFrame {
				break // corrupt length
			}
			payload := make([]byte, flen)
			if _, err := io.ReadFull(s, payload); err != nil {
				break // torn payload
			}
			if crc32.ChecksumIEEE(payload) != fcrc {
				break // corrupt payload
			}
			l.frames = append(l.frames, pos)
			resume = s.pos()
		}
	}

	l.gen, l.idx, l.off = resume.gen, resume.idx, resume.off
	if l.off == 0 {
		l.pageFirst = noFrame
	} else {
		l.pageFirst = firsts[l.idx]
	}
	l.committed = resume
	l.gcLocked()
	return l.flushHeaderLocked()
}

// pageStream concatenates the payload areas of a sequence of pages
// into a single byte stream for recovery replay.
type pageStream struct {
	f     *os.File
	pages []int
	gens  []uint32
	plens []uint32
	pi    int
	off   uint32
}

func (s *pageStream) pos() streamPos {
	pi := s.pi
	if pi >= len(s.pages) {
		pi = len(s.pages) - 1
	}
	pg := s.pages[pi]
	off := s.off
	if s.pi >= len(s.pages) {
		off = s.plens[pg]
	}
	return streamPos{gen: s.gens[pg], idx: uint32(pg), off: off}
}

func (s *pageStream) Read(p []byte) (int, error) {
	done := 0
	for done < len(p) {
		if s.pi >= len(s.pages) {
			if done > 0 {
				return done, nil
			}
			return 0, io.EOF
		}
		pg := s.pages[s.pi]
		plen := s.plens[pg]
		if s.off >= plen {
			// A non-final page that is not full means the stream
			// was torn here; do not skip ahead.
			if plen < pagePayloadCap && s.pi != len(s.pages)-1 {
				if done > 0 {
					return done, nil
				}
				return 0, io.EOF
			}
			s.pi++
			s.off = 0
			continue
		}
		n := min(int(plen-s.off), len(p)-done)
		if _, err := s.f.ReadAt(p[done:done+n], int64(pg)*PageSize+pageHeaderSize+int64(s.off)); err != nil {
			return done, err
		}
		s.off += uint32(n)
		done += n
	}
	return done, nil
}
