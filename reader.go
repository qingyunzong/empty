package ringlog

import (
	"encoding/binary"
	"hash/crc32"
	"io"
)

// Reader iterates frames from the oldest live position forward.
// It pins the page it currently holds so the writer cannot overwrite
// it; pages ahead of the reader are not protected, and if the writer
// laps them before the reader arrives, Next fails with ErrDataLost.
type Reader struct {
	l      *Logger
	pos    streamPos
	pinned uint32 // currently pinned page index, or noFrame
	closed bool
}

// NewReader returns a reader positioned at the oldest live frame.
func (l *Logger) NewReader() *Reader {
	l.mu.Lock()
	defer l.mu.Unlock()
	r := &Reader{l: l, pos: l.oldest, pinned: noFrame}
	l.pinLocked(l.oldest.idx)
	r.pinned = l.oldest.idx
	return r
}

// Next returns the next frame, or io.EOF when the reader has caught
// up with the writer.
func (r *Reader) Next() ([]byte, error) {
	r.l.mu.Lock()
	defer r.l.mu.Unlock()
	if r.closed {
		return nil, ErrClosed
	}
	var hdr [frameHeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	flen := binary.LittleEndian.Uint32(hdr[0:4])
	fcrc := binary.LittleEndian.Uint32(hdr[4:8])
	if flen > uint32(r.l.numPages)*pagePayloadCap {
		return nil, ErrCorrupt
	}
	payload := make([]byte, flen)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	if crc32.ChecksumIEEE(payload) != fcrc {
		return nil, ErrCorrupt
	}
	return payload, nil
}

// Read implements io.Reader over the frame stream. It must only be
// called with the logger lock held (Next does that).
func (r *Reader) Read(p []byte) (int, error) {
	done := 0
	for done < len(p) {
		if !posLess(r.pos, r.l.committed) {
			if done > 0 {
				return done, nil
			}
			return 0, io.EOF
		}
		if r.pos.off == pagePayloadCap {
			if err := r.crossLocked(); err != nil {
				if done > 0 {
					return done, nil
				}
				return 0, err
			}
			continue
		}
		n := pagePayloadCap - int(r.pos.off)
		if r.pos.gen == r.l.committed.gen && r.pos.idx == r.l.committed.idx {
			n = min(n, int(r.l.committed.off-r.pos.off))
		}
		n = min(n, len(p)-done)
		off := int64(r.pos.idx)*PageSize + pageHeaderSize + int64(r.pos.off)
		if _, err := r.l.f.ReadAt(p[done:done+n], off); err != nil {
			return done, err
		}
		r.pos.off += uint32(n)
		done += n
	}
	return done, nil
}

// crossLocked moves the reader to the next page, verifying that the
// page still carries the expected generation.
func (r *Reader) crossLocked() error {
	next := streamPos{gen: r.pos.gen, idx: r.pos.idx + 1}
	if next.idx == r.l.numPages {
		next = streamPos{gen: r.pos.gen + 1, idx: 0}
	}
	gen, err := r.l.pageGenLocked(next.idx)
	if err != nil {
		return err
	}
	if gen != next.gen {
		return ErrDataLost
	}
	r.l.unpinLocked(r.pinned)
	r.l.pinLocked(next.idx)
	r.pinned = next.idx
	r.pos = next
	return nil
}

// Close releases the reader's pinned page.
func (r *Reader) Close() error {
	r.l.mu.Lock()
	defer r.l.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	r.l.unpinLocked(r.pinned)
	r.pinned = noFrame
	return nil
}
