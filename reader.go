package ringlog

import (
	"hash/crc32"
	"io"
)

// cursor is a logical stream position: (generation, page, offset in page).
type cursor struct {
	gen uint64
	idx int
	off int
}

// Reader iterates over the live frames of a Logger. It pins the page it
// rests on, so the writer can never overwrite it and instead gets
// ErrBackpressure. A Reader is not safe for concurrent use.
type Reader struct {
	l      *Logger
	pos    cursor
	closed bool
}

// NewReader creates a reader positioned at the oldest live frame.
func (l *Logger) NewReader() *Reader {
	l.mu.Lock()
	defer l.mu.Unlock()
	cur := l.keyOf(l.gen, l.wpage)
	start := cur - int64(l.numPages-1)
	if start < 0 {
		start = 0
	}
	// Skip torn or empty pages at the bottom of the live window.
	for start < cur {
		idx := int(uint64(start) % uint64(l.numPages))
		g := uint64(start) / uint64(l.numPages)
		if l.pageGen[idx] == g && l.pageUsed[idx] > 0 {
			break
		}
		start++
	}
	r := &Reader{l: l, pos: cursor{
		gen: uint64(start) / uint64(l.numPages),
		idx: int(uint64(start) % uint64(l.numPages)),
	}}
	l.pinLocked(r.pos.idx)
	return r
}

func (l *Logger) frontierLocked() cursor {
	return cursor{gen: l.gen, idx: l.wpage, off: l.pageUsed[l.wpage]}
}

// Next returns the next frame payload, or io.EOF when caught up with the
// writer. Torn or corrupt bytes are skipped by resynchronizing on the
// frame magic; ErrLapped is returned if the writer passed this reader.
func (r *Reader) Next() ([]byte, error) {
	l := r.l
	l.mu.Lock()
	defer l.mu.Unlock()
	if r.closed {
		return nil, ErrClosed
	}
	for {
		if r.pos == l.frontierLocked() {
			return nil, io.EOF
		}
		if l.pageGen[r.pos.idx] != r.pos.gen {
			return nil, ErrLapped
		}
		payload, end, ok, err := l.scanFrameLocked(r.pos)
		if err != nil {
			return nil, err
		}
		if ok {
			r.moveToLocked(end)
			return payload, nil
		}
		if err := r.skipLocked(1); err != nil {
			return nil, err
		}
	}
}

// Close releases the reader's page pin.
func (r *Reader) Close() error {
	r.l.mu.Lock()
	defer r.l.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	r.l.unpinLocked(r.pos.idx)
	return nil
}

func (r *Reader) moveToLocked(c cursor) {
	if c.idx != r.pos.idx {
		r.l.unpinLocked(r.pos.idx)
		r.l.pinLocked(c.idx)
	}
	r.pos = c
}

// skipLocked advances the reader by up to n stream bytes, moving the pin
// across page boundaries. It stops silently at the write frontier.
func (r *Reader) skipLocked(n int) error {
	l := r.l
	for n > 0 {
		if r.pos == l.frontierLocked() {
			return nil
		}
		if l.pageGen[r.pos.idx] != r.pos.gen {
			return ErrLapped
		}
		if r.pos.off == l.pageUsed[r.pos.idx] {
			next := (r.pos.idx + 1) % l.numPages
			ngen := r.pos.gen
			if next == 0 {
				ngen++
			}
			if l.pageGen[next] != ngen {
				return ErrLapped
			}
			l.unpinLocked(r.pos.idx)
			l.pinLocked(next)
			r.pos = cursor{gen: ngen, idx: next, off: 0}
			continue
		}
		r.pos.off++
		n--
	}
	return nil
}

// readFromLocked reads up to n committed stream bytes starting at c,
// stopping short at the write frontier.
func (l *Logger) readFromLocked(c cursor, n int) ([]byte, cursor, error) {
	out := make([]byte, 0, n)
	for len(out) < n {
		if c == l.frontierLocked() {
			return out, c, nil
		}
		if l.pageGen[c.idx] != c.gen {
			return nil, c, ErrLapped
		}
		used := l.pageUsed[c.idx]
		if c.off == used {
			next := (c.idx + 1) % l.numPages
			ngen := c.gen
			if next == 0 {
				ngen++
			}
			if l.pageGen[next] != ngen {
				return nil, c, ErrLapped
			}
			c = cursor{gen: ngen, idx: next, off: 0}
			continue
		}
		m := min(used-c.off, n-len(out))
		buf := make([]byte, m)
		if _, err := l.f.ReadAt(buf, int64(c.idx*l.pageSize+HeaderSize+c.off)); err != nil {
			return nil, c, err
		}
		out = append(out, buf...)
		c.off += m
	}
	return out, c, nil
}

// scanFrameLocked tries to read one valid frame at c without moving c.
func (l *Logger) scanFrameLocked(c cursor) (payload []byte, end cursor, ok bool, err error) {
	hdr, c2, err := l.readFromLocked(c, FrameHeaderSize)
	if err != nil {
		return nil, c, false, err
	}
	if len(hdr) < FrameHeaderSize {
		return nil, c, false, nil
	}
	n, crc, ok := parseFrameHeader(hdr)
	if !ok || n > MaxFrameSize {
		return nil, c, false, nil
	}
	payload, c3, err := l.readFromLocked(c2, int(n))
	if err != nil {
		return nil, c, false, err
	}
	if len(payload) < int(n) || crc32.ChecksumIEEE(payload) != crc {
		return nil, c, false, nil
	}
	return payload, c3, true, nil
}
