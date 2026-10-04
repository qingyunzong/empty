// Package ringlog implements a telemetry logger that stores variable-length
// frames in a fixed-page ring file.
//
// File format:
//   - The file is a ring of numPages fixed-size pages.
//   - Each page starts with a 24-byte header: magic, generation, page index,
//     committed data length, and a CRC32 over the first 20 header bytes.
//     The generation is incremented every time the writer wraps past page 0,
//     so pages written by previous laps are distinguishable after wrap-around.
//   - Frames are variable-length and packed back to back across page data
//     regions. A frame may span any number of pages, including the ring wrap
//     point. Frame header: magic, payload length, payload CRC32 (12 bytes).
//   - A frame becomes visible only when the headers of every page it touches
//     have been (re)committed with the covering data length: data bytes are
//     written first, the page header commit is the atomic publish step.
//
// Readers pin the page they rest on. The writer never overwrites a pinned
// page; if a write would need one it fails with ErrBackpressure before any
// byte is written, so backpressure never creates a partial frame.
//
// Recovery validates page headers and frame CRCs, replays the newest live
// window of pages in (generation, index) order, and keeps the complete
// prefix of valid frames, resynchronizing across torn regions through the
// frame magic. See README.md for the enumerated fault points.
package ringlog

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"sync"
)

const (
	// Magic is the page header magic ("RLOG").
	Magic uint32 = 0x524c4f47
	// FrameMagic is the frame header magic ("FRM1"), used to resynchronize
	// the stream after a torn region.
	FrameMagic uint32 = 0x46524d31
	// HeaderSize is the page header size in bytes.
	HeaderSize = 24
	// FrameHeaderSize is the frame header size in bytes.
	FrameHeaderSize = 12
	// MaxFrameSize is the maximum payload size of a single frame.
	MaxFrameSize = 1 << 20
)

var (
	// ErrBackpressure is returned by Write when the frame would have to
	// overwrite a page currently pinned by a reader. Nothing is written.
	ErrBackpressure = errors.New("ringlog: write blocked by reader-pinned pages (backpressure)")
	// ErrFrameTooLarge is returned when a frame can never fit in the ring.
	ErrFrameTooLarge = errors.New("ringlog: frame too large for ring")
	// ErrLapped is returned by a reader whose next page was overwritten by
	// the writer. With page pinning this is only a defensive check.
	ErrLapped = errors.New("ringlog: reader lapped by writer")
	// ErrClosed is returned when operating on a closed logger or reader.
	ErrClosed = errors.New("ringlog: closed")
)

func encodeHeader(dst []byte, gen uint64, idx, dataLen uint32) {
	binary.LittleEndian.PutUint32(dst[0:4], Magic)
	binary.LittleEndian.PutUint64(dst[4:12], gen)
	binary.LittleEndian.PutUint32(dst[12:16], idx)
	binary.LittleEndian.PutUint32(dst[16:20], dataLen)
	binary.LittleEndian.PutUint32(dst[20:24], crc32.ChecksumIEEE(dst[0:20]))
}

func decodeHeader(src []byte) (gen uint64, idx, dataLen uint32, ok bool) {
	if binary.LittleEndian.Uint32(src[0:4]) != Magic {
		return 0, 0, 0, false
	}
	if binary.LittleEndian.Uint32(src[20:24]) != crc32.ChecksumIEEE(src[0:20]) {
		return 0, 0, 0, false
	}
	return binary.LittleEndian.Uint64(src[4:12]),
		binary.LittleEndian.Uint32(src[12:16]),
		binary.LittleEndian.Uint32(src[16:20]), true
}

func encodeFrameHeader(dst []byte, n, crc uint32) {
	binary.LittleEndian.PutUint32(dst[0:4], FrameMagic)
	binary.LittleEndian.PutUint32(dst[4:8], n)
	binary.LittleEndian.PutUint32(dst[8:12], crc)
}

func parseFrameHeader(src []byte) (n, crc uint32, ok bool) {
	if binary.LittleEndian.Uint32(src[0:4]) != FrameMagic {
		return 0, 0, false
	}
	return binary.LittleEndian.Uint32(src[4:8]), binary.LittleEndian.Uint32(src[8:12]), true
}

// Logger appends frames to the ring file. It is safe for concurrent use.
type Logger struct {
	mu       sync.Mutex
	f        *os.File
	pageSize int
	numPages int
	closed   bool

	pageGen  []uint64 // committed generation per page
	pageUsed []int    // committed data bytes per page

	gen   uint64 // generation of the write page
	wpage int    // write page index
	wused int    // bytes used in the write page

	pins map[int]int // page index -> pin count held by readers
}

// Open creates or recovers a ring file at path with the given geometry.
func Open(path string, numPages, pageSize int) (*Logger, error) {
	if numPages < 2 {
		return nil, fmt.Errorf("ringlog: need at least 2 pages, got %d", numPages)
	}
	if pageSize < HeaderSize+1 {
		return nil, fmt.Errorf("ringlog: page size %d too small", pageSize)
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	l := &Logger{
		f:        f,
		pageSize: pageSize,
		numPages: numPages,
		pageGen:  make([]uint64, numPages),
		pageUsed: make([]int, numPages),
		pins:     make(map[int]int),
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	want := int64(numPages * pageSize)
	switch {
	case st.Size() == 0:
		if err := f.Truncate(want); err != nil {
			f.Close()
			return nil, err
		}
		if err := l.commitHeaderLocked(0); err != nil {
			f.Close()
			return nil, err
		}
	case st.Size() != want:
		f.Close()
		return nil, fmt.Errorf("ringlog: file size %d does not match geometry %d", st.Size(), want)
	default:
		if err := l.recoverLocked(); err != nil {
			f.Close()
			return nil, err
		}
	}
	return l, nil
}

func (l *Logger) dataCap() int { return l.pageSize - HeaderSize }

func (l *Logger) keyOf(gen uint64, idx int) int64 {
	return int64(gen)*int64(l.numPages) + int64(idx)
}

func (l *Logger) commitHeaderLocked(idx int) error {
	var buf [HeaderSize]byte
	encodeHeader(buf[:], l.pageGen[idx], uint32(idx), uint32(l.pageUsed[idx]))
	_, err := l.f.WriteAt(buf[:], int64(idx*l.pageSize))
	return err
}

// Write appends one frame, spanning pages if needed. It returns
// ErrBackpressure (without writing anything) if the frame would overwrite a
// reader-pinned page, and ErrFrameTooLarge if it can never fit.
func (l *Logger) Write(payload []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrClosed
	}
	need := FrameHeaderSize + len(payload)
	if len(payload) > MaxFrameSize || need > l.numPages*l.dataCap() {
		return ErrFrameTooLarge
	}
	if err := l.checkCapacityLocked(need); err != nil {
		return err
	}
	frame := make([]byte, need)
	encodeFrameHeader(frame, uint32(len(payload)), crc32.ChecksumIEEE(payload))
	copy(frame[FrameHeaderSize:], payload)
	touched := make([]int, 0, 2)
	for len(frame) > 0 {
		avail := l.dataCap() - l.wused
		if avail == 0 {
			if err := l.advanceLocked(); err != nil {
				return err
			}
			continue
		}
		n := min(avail, len(frame))
		off := int64(l.wpage*l.pageSize + HeaderSize + l.wused)
		if _, err := l.f.WriteAt(frame[:n], off); err != nil {
			return err
		}
		l.wused += n
		l.pageUsed[l.wpage] = l.wused
		if len(touched) == 0 || touched[len(touched)-1] != l.wpage {
			touched = append(touched, l.wpage)
		}
		frame = frame[n:]
	}
	// Publish: commit headers only after all data bytes are on disk.
	for _, idx := range touched {
		if err := l.commitHeaderLocked(idx); err != nil {
			return err
		}
	}
	return nil
}

// checkCapacityLocked simulates page advancement for need bytes and fails
// with ErrBackpressure if any required page is pinned by a reader.
func (l *Logger) checkCapacityLocked(need int) error {
	used := l.wused
	idx := l.wpage
	for {
		if avail := l.dataCap() - used; need <= avail {
			return nil
		} else {
			need -= avail
		}
		idx = (idx + 1) % l.numPages
		if l.pins[idx] > 0 {
			return ErrBackpressure
		}
		used = 0
	}
}

// advanceLocked moves the writer to the next page, bumping the generation
// on wrap-around, and invalidates that page by committing an empty header.
func (l *Logger) advanceLocked() error {
	next := (l.wpage + 1) % l.numPages
	gen := l.gen
	if next == 0 {
		gen++
	}
	if l.pins[next] > 0 {
		return ErrBackpressure
	}
	l.gen, l.wpage, l.wused = gen, next, 0
	l.pageGen[next] = gen
	l.pageUsed[next] = 0
	return l.commitHeaderLocked(next)
}

// Sync flushes the ring file to stable storage.
func (l *Logger) Sync() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrClosed
	}
	return l.f.Sync()
}

// Close closes the ring file.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	return l.f.Close()
}

func (l *Logger) pinLocked(idx int) { l.pins[idx]++ }

func (l *Logger) unpinLocked(idx int) {
	if l.pins[idx] <= 1 {
		delete(l.pins, idx)
	} else {
		l.pins[idx]--
	}
}

// scanFrames returns the offset just past the last complete valid frame in
// stream, resynchronizing via the frame magic across torn regions.
func scanFrames(stream []byte) (consumed int) {
	off := 0
	for off+FrameHeaderSize <= len(stream) {
		n, crc, ok := parseFrameHeader(stream[off:])
		if !ok || n > MaxFrameSize || off+FrameHeaderSize+int(n) > len(stream) {
			off++
			continue
		}
		if crc32.ChecksumIEEE(stream[off+FrameHeaderSize:off+FrameHeaderSize+int(n)]) != crc {
			off++
			continue
		}
		off += FrameHeaderSize + int(n)
		consumed = off
	}
	return consumed
}

// recoverLocked rebuilds the writer state from the newest live window of
// pages, keeping the complete prefix of valid frames.
func (l *Logger) recoverLocked() error {
	type pageState struct {
		valid bool
		gen   uint64
		used  int
	}
	pages := make([]pageState, l.numPages)
	hbuf := make([]byte, HeaderSize)
	maxKey := int64(-1)
	for i := 0; i < l.numPages; i++ {
		if _, err := l.f.ReadAt(hbuf, int64(i*l.pageSize)); err != nil {
			return fmt.Errorf("ringlog: read page %d header: %w", i, err)
		}
		gen, idx, used, ok := decodeHeader(hbuf)
		if !ok || int(idx) != i || used > uint32(l.dataCap()) {
			continue
		}
		pages[i] = pageState{valid: true, gen: gen, used: int(used)}
		if k := l.keyOf(gen, i); k > maxKey {
			maxKey = k
		}
	}
	if maxKey < 0 {
		l.gen, l.wpage, l.wused = 0, 0, 0
		return l.commitHeaderLocked(0)
	}
	windowStart := maxKey - int64(l.numPages-1)
	if windowStart < 0 {
		windowStart = 0
	}
	inWindow := func(k int64) (int, uint64, bool) {
		idx := int(uint64(k) % uint64(l.numPages))
		g := uint64(k) / uint64(l.numPages)
		p := pages[idx]
		return idx, g, p.valid && p.gen == g
	}
	var stream []byte
	for k := windowStart; k <= maxKey; k++ {
		idx, _, ok := inWindow(k)
		if !ok {
			continue
		}
		data := make([]byte, pages[idx].used)
		if _, err := l.f.ReadAt(data, int64(idx*l.pageSize+HeaderSize)); err != nil {
			return fmt.Errorf("ringlog: read page %d data: %w", idx, err)
		}
		stream = append(stream, data...)
		l.pageGen[idx] = pages[idx].gen
		l.pageUsed[idx] = pages[idx].used
	}
	consumed := scanFrames(stream)
	// Map the consumed prefix back to a (page, offset) resume position.
	remaining := consumed
	wkey := windowStart
	wused := 0
	for k := windowStart; k <= maxKey; k++ {
		idx, _, ok := inWindow(k)
		if !ok {
			continue
		}
		if remaining <= pages[idx].used {
			wkey, wused = k, remaining
			break
		}
		remaining -= pages[idx].used
		wkey, wused = k, pages[idx].used
	}
	l.gen = uint64(wkey) / uint64(l.numPages)
	l.wpage = int(uint64(wkey) % uint64(l.numPages))
	l.wused = wused
	// Pages past the resume position hold only torn data; forget them so
	// readers stop at the frontier and the writer overwrites them cleanly.
	for k := wkey + 1; k <= maxKey; k++ {
		idx := int(uint64(k) % uint64(l.numPages))
		if l.keyOf(l.pageGen[idx], idx) == k {
			l.pageGen[idx] = 0
			l.pageUsed[idx] = 0
		}
	}
	l.pageGen[l.wpage] = l.gen
	l.pageUsed[l.wpage] = l.wused
	return l.commitHeaderLocked(l.wpage)
}
