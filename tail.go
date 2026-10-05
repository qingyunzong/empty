// Package tail implements a follow-the-tail reader for append-only
// variable-length record logs split across rotated segment files.
//
// Record format: 4-byte big-endian uint32 length prefix followed by the
// payload. Segment files live in one directory and are named %06d.seg
// with monotonically increasing numbers.
package tail

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ErrWait is returned by Next when the tail of the current segment holds
// an incomplete record (or no data at all) and no newer segment exists.
// The reader's cursor is left unchanged, so the caller may retry later.
var ErrWait = errors.New("tail: incomplete record at tail, wait for more data")

// CorruptError reports a definitive mid-stream decoding failure, as
// opposed to an incomplete tail which yields ErrWait.
type CorruptError struct {
	Segment int
	Offset  int64
	Reason  string
}

func (e *CorruptError) Error() string {
	return fmt.Sprintf("tail: corrupt record in segment %06d at offset %d: %s", e.Segment, e.Offset, e.Reason)
}

// Record is one decoded log record.
type Record struct {
	Segment int    // segment file the record was read from
	Offset  int64  // offset of the record header within the segment
	Data    []byte // payload, length prefix stripped
}

const headerSize = 4

// DefaultMaxRecordSize bounds a single record payload; a length prefix
// above it is treated as corruption rather than an incomplete tail.
const DefaultMaxRecordSize = 1 << 20

// Reader follows an append-only log across rotated segment files.
type Reader struct {
	dir     string
	maxSize uint32

	seg    int
	file   *os.File
	offset int64
}

// Open creates a Reader positioned at the start of the oldest segment in
// dir. It is not an error for dir to contain no segments yet.
func Open(dir string) (*Reader, error) {
	segs, err := listSegments(dir)
	if err != nil {
		return nil, err
	}
	r := &Reader{dir: dir, maxSize: DefaultMaxRecordSize, seg: -1}
	if len(segs) > 0 {
		if err := r.openSegment(segs[0]); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// Position reports the current cursor: the segment being read and the
// offset of the next record header within it.
func (r *Reader) Position() (segment int, offset int64) {
	return r.seg, r.offset
}

// Next decodes the next record. It returns ErrWait when the tail is
// incomplete (cursor preserved) and *CorruptError on definitive
// mid-stream corruption. After the current segment is fully consumed and
// a newer segment exists, Next transparently switches to it.
func (r *Reader) Next() (Record, error) {
	for {
		if r.file == nil {
			next, err := r.nextSegment()
			if err != nil {
				return Record{}, err
			}
			if next < 0 {
				return Record{}, ErrWait
			}
			if err := r.openSegment(next); err != nil {
				return Record{}, err
			}
		}

		rec, err := r.readRecord()
		if err == nil {
			return rec, nil
		}
		if !errors.Is(err, ErrWait) {
			return Record{}, err
		}

		// Incomplete or exhausted tail: rotate only at a clean
		// boundary, i.e. no partial bytes remain in the old handle.
		if r.atCleanEOF() {
			next, nerr := r.nextSegment()
			if nerr != nil {
				return Record{}, nerr
			}
			if next >= 0 {
				if cerr := r.file.Close(); cerr != nil {
					return Record{}, cerr
				}
				r.file = nil
				if err := r.openSegment(next); err != nil {
					return Record{}, err
				}
				continue
			}
		}
		return Record{}, ErrWait
	}
}

// Close releases the current segment handle.
func (r *Reader) Close() error {
	if r.file == nil {
		return nil
	}
	err := r.file.Close()
	r.file = nil
	return err
}

// readRecord attempts to decode one record at the cursor. The cursor is
// only advanced on success.
func (r *Reader) readRecord() (Record, error) {
	var hdr [headerSize]byte
	n, err := r.file.ReadAt(hdr[:], r.offset)
	if err != nil && err != io.EOF {
		return Record{}, err
	}
	if n < headerSize {
		return Record{}, ErrWait
	}
	length := binary.BigEndian.Uint32(hdr[:])
	if length > r.maxSize {
		return Record{}, &CorruptError{
			Segment: r.seg,
			Offset:  r.offset,
			Reason:  fmt.Sprintf("length prefix %d exceeds max %d", length, r.maxSize),
		}
	}
	buf := make([]byte, length)
	n, err = r.file.ReadAt(buf, r.offset+headerSize)
	if err != nil && err != io.EOF {
		return Record{}, err
	}
	if n < int(length) {
		return Record{}, ErrWait
	}
	rec := Record{Segment: r.seg, Offset: r.offset, Data: buf}
	r.offset += headerSize + int64(length)
	return rec, nil
}

// atCleanEOF reports whether the cursor sits exactly at end of file with
// no partial record bytes remaining.
func (r *Reader) atCleanEOF() bool {
	info, err := r.file.Stat()
	if err != nil {
		return false
	}
	return info.Size() == r.offset
}

// nextSegment returns the number of the smallest segment greater than
// r.seg, or -1 if none exists yet.
func (r *Reader) nextSegment() (int, error) {
	segs, err := listSegments(r.dir)
	if err != nil {
		return -1, err
	}
	for _, s := range segs {
		if s > r.seg {
			return s, nil
		}
	}
	return -1, nil
}

func (r *Reader) openSegment(seg int) error {
	f, err := os.Open(segmentPath(r.dir, seg))
	if err != nil {
		return err
	}
	if r.file != nil {
		r.file.Close()
	}
	r.file = f
	r.seg = seg
	r.offset = 0
	return nil
}

// SegmentPath returns the file path of segment number seg in dir.
func SegmentPath(dir string, seg int) string { return segmentPath(dir, seg) }

func segmentPath(dir string, seg int) string {
	return filepath.Join(dir, fmt.Sprintf("%06d.seg", seg))
}

func listSegments(dir string) ([]int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var segs []int
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".seg") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSuffix(name, ".seg"))
		if err != nil {
			continue
		}
		segs = append(segs, n)
	}
	sort.Ints(segs)
	return segs, nil
}
