// Package ringlog implements a telemetry logger that persists
// variable-length frames in a fixed-size ring file composed of
// fixed-size pages.
//
// Layout: the file is numPages * PageSize bytes. Every page starts
// with a 32-byte header (magic, generation, page index, payload
// length, first-frame offset, CRC32). Frames (8-byte header of
// length+CRC32, then payload) are packed into page payload areas and
// may span page boundaries, including the end-of-file wraparound
// boundary.
//
// The per-page generation number is incremented every time the writer
// laps the ring, so recovery can tell current-lap pages apart from
// stale pages left over from previous laps.
//
// Readers pin the page they currently hold. The writer never
// overwrites a pinned page; if a frame cannot be written without
// doing so, Write fails with ErrBackpressure.
//
// Recovery after a crash validates page headers and frame CRCs and
// restores the last complete prefix of the frame stream. See
// FAILURES.md for the enumerated cross-page and wraparound failure
// points and how each is handled.
package ringlog

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
	"sync"
)

const (
	// PageSize is the fixed size of one page in the ring file.
	PageSize = 4096

	pageHeaderSize  = 32
	frameHeaderSize = 8
	pagePayloadCap  = PageSize - pageHeaderSize
	pageMagic       = 0x544c4f47 // "TLOG"
	initialGen      = 1
	noFrame         = ^uint32(0)
)

var (
	// ErrBackpressure is returned by Write when the frame cannot be
	// written because one or more pages it would occupy are pinned
	// by a reader.
	ErrBackpressure = errors.New("ringlog: insufficient space: reader-held pages block the write")
	// ErrFrameTooLarge is returned when a frame can never fit in the ring.
	ErrFrameTooLarge = errors.New("ringlog: frame exceeds ring capacity")
	// ErrDataLost is returned by a reader whose next page was overwritten
	// by a newer generation before it could be pinned.
	ErrDataLost = errors.New("ringlog: reader position overwritten by a newer generation")
	// ErrCorrupt indicates a frame failed validation.
	ErrCorrupt = errors.New("ringlog: corrupt frame")
	// ErrClosed is returned on use of a closed Logger or Reader.
	ErrClosed = errors.New("ringlog: closed")
	// ErrInvalid indicates a malformed ring file or bad geometry.
	ErrInvalid = errors.New("ringlog: invalid ring file")
)

// streamPos is a logical byte position in the ring stream.
type streamPos struct {
	gen uint32 // generation of the page
	idx uint32 // page index
	off uint32 // offset within the page payload area
}

func posLess(a, b streamPos) bool {
	if a.gen != b.gen {
		return a.gen < b.gen
	}
	if a.idx != b.idx {
		return a.idx < b.idx
	}
	return a.off < b.off
}

// Page header layout (32 bytes):
//
//	[0:4]   magic
//	[4:8]   generation
//	[8:12]  page index
//	[12:16] payload length (valid stream bytes in this page)
//	[16:20] first-frame offset within payload, or noFrame
//	[20:24] CRC32 of bytes [0:20]
//	[24:32] reserved (zero)
func encodePageHeader(buf []byte, gen, idx, payloadLen, firstOff uint32) {
	for i := range buf {
		buf[i] = 0
	}
	binary.LittleEndian.PutUint32(buf[0:4], pageMagic)
	binary.LittleEndian.PutUint32(buf[4:8], gen)
	binary.LittleEndian.PutUint32(buf[8:12], idx)
	binary.LittleEndian.PutUint32(buf[12:16], payloadLen)
	binary.LittleEndian.PutUint32(buf[16:20], firstOff)
	binary.LittleEndian.PutUint32(buf[20:24], crc32.ChecksumIEEE(buf[0:20]))
}

func decodePageHeader(buf []byte) (gen, idx, payloadLen, firstOff uint32, ok bool) {
	if binary.LittleEndian.Uint32(buf[0:4]) != pageMagic {
		return 0, 0, 0, 0, false
	}
	if binary.LittleEndian.Uint32(buf[20:24]) != crc32.ChecksumIEEE(buf[0:20]) {
		return 0, 0, 0, 0, false
	}
	gen = binary.LittleEndian.Uint32(buf[4:8])
	idx = binary.LittleEndian.Uint32(buf[8:12])
	payloadLen = binary.LittleEndian.Uint32(buf[12:16])
	firstOff = binary.LittleEndian.Uint32(buf[16:20])
	if payloadLen > pagePayloadCap {
		return 0, 0, 0, 0, false
	}
	if firstOff != noFrame && firstOff > pagePayloadCap {
		return 0, 0, 0, 0, false
	}
	return gen, idx, payloadLen, firstOff, true
}

// Logger appends frames to the ring file. It is safe for concurrent use.
type Logger struct {
	f         *os.File
	numPages  uint32
	ringBytes int64

	mu        sync.Mutex
	gen       uint32
	idx       uint32
	off       uint32
	pageFirst uint32 // first-frame offset of the current page, or noFrame
	committed streamPos
	oldest    streamPos
	frames    []streamPos // FIFO of live frame start positions
	pinned    map[uint32]int
	closed    bool
}

func newLogger(f *os.File, numPages uint32) *Logger {
	return &Logger{
		f:         f,
		numPages:  numPages,
		ringBytes: int64(numPages) * pagePayloadCap,
		gen:       initialGen,
		pageFirst: noFrame,
		committed: streamPos{gen: initialGen},
		oldest:    streamPos{gen: initialGen},
		pinned:    make(map[uint32]int),
	}
}

// Create creates a fresh ring file of numPages pages at path.
func Create(path string, numPages uint32) (*Logger, error) {
	if numPages < 2 {
		return nil, ErrInvalid
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	if err := f.Truncate(int64(numPages) * PageSize); err != nil {
		f.Close()
		return nil, err
	}
	l := newLogger(f, numPages)
	if err := l.flushHeaderLocked(); err != nil {
		f.Close()
		return nil, err
	}
	return l, nil
}

// Write appends one frame to the ring. It returns ErrBackpressure if
// the frame cannot be placed without overwriting a reader-pinned page,
// and ErrFrameTooLarge if the frame can never fit in the ring.
func (l *Logger) Write(frame []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrClosed
	}
	need := frameHeaderSize + len(frame)
	if need > (int(l.numPages)-1)*pagePayloadCap {
		return ErrFrameTooLarge
	}
	if err := l.preflightLocked(need); err != nil {
		return err
	}

	rec := make([]byte, need)
	binary.LittleEndian.PutUint32(rec[0:4], uint32(len(frame)))
	binary.LittleEndian.PutUint32(rec[4:8], crc32.ChecksumIEEE(frame))
	copy(rec[frameHeaderSize:], frame)

	if l.off == pagePayloadCap {
		if err := l.advanceLocked(); err != nil {
			return err
		}
	}
	start := streamPos{l.gen, l.idx, l.off}
	if l.pageFirst == noFrame {
		l.pageFirst = l.off
	}
	written := 0
	for written < need {
		if l.off == pagePayloadCap {
			if err := l.advanceLocked(); err != nil {
				return err
			}
		}
		n := min(pagePayloadCap-int(l.off), need-written)
		poff := int64(l.idx)*PageSize + pageHeaderSize + int64(l.off)
		if _, err := l.f.WriteAt(rec[written:written+n], poff); err != nil {
			return err
		}
		l.off += uint32(n)
		written += n
	}
	l.frames = append(l.frames, start)
	l.committed = streamPos{l.gen, l.idx, l.off}
	l.gcLocked()
	return l.flushHeaderLocked()
}

// preflightLocked checks that every page the record would occupy is
// not pinned by a reader, before any byte is written.
func (l *Logger) preflightLocked(need int) error {
	remaining := need - (pagePayloadCap - int(l.off))
	if remaining <= 0 {
		return nil
	}
	pages := (remaining + pagePayloadCap - 1) / pagePayloadCap
	idx := l.idx
	for i := 0; i < pages; i++ {
		idx++
		if idx == l.numPages {
			idx = 0
		}
		if l.pinned[idx] > 0 {
			return ErrBackpressure
		}
	}
	return nil
}

// advanceLocked seals the current page and moves to the next one,
// lapping the ring (and bumping the generation) at the end of file.
func (l *Logger) advanceLocked() error {
	if err := l.flushHeaderLocked(); err != nil {
		return err
	}
	next := l.idx + 1
	if next == l.numPages {
		next = 0
		l.gen++
	}
	if l.pinned[next] > 0 {
		return ErrBackpressure
	}
	l.idx, l.off, l.pageFirst = next, 0, noFrame
	return l.flushHeaderLocked()
}

func (l *Logger) flushHeaderLocked() error {
	var hdr [pageHeaderSize]byte
	encodePageHeader(hdr[:], l.gen, l.idx, l.off, l.pageFirst)
	_, err := l.f.WriteAt(hdr[:], int64(l.idx)*PageSize)
	return err
}

// gcLocked drops frames whose start page has been lapped. A frame is
// destroyed as soon as the writer re-enters the page containing its
// start, because that rewrites the page header (and its generation).
func (l *Logger) gcLocked() {
	frontier := l.absLocked(l.committed)
	for len(l.frames) > 0 && l.pageAbsLocked(l.frames[0])+l.ringBytes <= frontier {
		l.frames = l.frames[1:]
	}
	if cap(l.frames) >= 64 && 2*len(l.frames) < cap(l.frames) {
		l.frames = append([]streamPos(nil), l.frames...)
	}
	if len(l.frames) > 0 {
		l.oldest = l.frames[0]
	} else {
		l.oldest = l.committed
	}
}

func (l *Logger) absLocked(p streamPos) int64 {
	return int64(p.gen-initialGen)*l.ringBytes + int64(p.idx)*pagePayloadCap + int64(p.off)
}

func (l *Logger) pageAbsLocked(p streamPos) int64 {
	return int64(p.gen-initialGen)*l.ringBytes + int64(p.idx)*pagePayloadCap
}

func (l *Logger) pageGenLocked(idx uint32) (uint32, error) {
	var hdr [pageHeaderSize]byte
	if _, err := l.f.ReadAt(hdr[:], int64(idx)*PageSize); err != nil {
		return 0, err
	}
	gen, hidx, _, _, ok := decodePageHeader(hdr[:])
	if !ok || hidx != idx {
		return 0, ErrCorrupt
	}
	return gen, nil
}

func (l *Logger) pinLocked(idx uint32) {
	l.pinned[idx]++
}

func (l *Logger) unpinLocked(idx uint32) {
	if idx == noFrame {
		return
	}
	if l.pinned[idx] <= 1 {
		delete(l.pinned, idx)
	} else {
		l.pinned[idx]--
	}
}

// Close flushes the current page header and closes the file.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrClosed
	}
	l.closed = true
	if err := l.flushHeaderLocked(); err != nil {
		return err
	}
	return l.f.Close()
}
