package tailer

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// Status is the outcome of a Reader.Next call.
type Status int

const (
	// StatusRecord means Next returned a complete record and advanced the cursor.
	StatusRecord Status = iota
	// StatusWait means the tail is incomplete (or no data exists yet); the
	// cursor is left unchanged so a later Next call retries the same record.
	StatusWait
	// StatusFail means the bytes at the cursor are provably corrupt.
	StatusFail
)

func (s Status) String() string {
	switch s {
	case StatusRecord:
		return "Record"
	case StatusWait:
		return "Wait"
	case StatusFail:
		return "Fail"
	}
	return "Unknown"
}

// Record is one decoded record together with its provenance.
type Record struct {
	Segment int    // id of the segment file the record was read from
	Offset  int64  // byte offset of the record header within the segment
	Payload []byte // record payload (owned by the caller)
}

// Reader follows an append-only sequence of segment files. It is not safe for
// concurrent use.
type Reader struct {
	dir string
	f   *os.File
	seg int
	off int64
}

// Open creates a Reader positioned at the start first segment in dir.
// The directory may be empty; Next will report StatusWait until data appears.
func Open(dir string) (*Reader, error) {
	r := &Reader{dir: dir, seg: -1}
	if err := r.openFirst(); err != nil {
		return nil, err
	}
	return r, nil
}

// openFirst opens the lowest-numbered existing segment, if any exist yet.
func (r *Reader) openFirst() error {
	ids, err := listSegments(r.dir)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	return r.openSegment(ids[0])
}

func (r *Reader) openSegment(id int) error {
	if r.f != nil {
		if err := r.f.Close(); err != nil {
			return err
		}
	}
	f, err := os.Open(segmentPath(r.dir, id))
	if err != nil {
		return err
	}
	r.f, r.seg, r.off = f, id, 0
	return nil
}

// Position reports the current cursor: the segment and byte offset at which
// the next record will be read.
func (r *Reader) Position() (segment int, offset int64) { return r.seg, r.off }

// Segment returns the id of the segment currently being read.
func (r *Reader) Segment() int { return r.seg }

// Close releases the underlying file handle.
func (r *Reader) Close() error {
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

// Next attempts to read one record at the cursor.
//
//   - A complete record yields StatusRecord and the cursor advances past it.
//   - An incomplete tail (partial header or payload) yields StatusWait and
//     the cursor is preserved, so the caller can retry after more data lands.
//   - At a clean segment boundary the Reader rotates: it finishes the old
//     handle, then continues with the next segment if one already exists,
//     otherwise it waits for more appends.
//   - Corrupt bytes (bad magic, absurd length, CRC mismatch, or a record
//     torn by rotation) yield StatusFail with a descriptive error.
func (r *Reader) Next() (Record, Status, error) {
	for {
		if r.f == nil {
			if err := r.openFirst(); err != nil {
				return Record{}, StatusFail, err
			}
			if r.f == nil {
				return Record{}, StatusWait, nil // no segment files yet
			}
		}

		var hdr [headerLen]byte
		n, err := r.f.ReadAt(hdr[:], r.off)
		if err == io.EOF {
			if n == 0 {
				// Clean boundary: rotate if a newer segment exists.
				next, ok, lerr := nextSegmentAfter(r.dir, r.seg)
				if lerr != nil {
					return Record{}, StatusFail, lerr
				}
				if !ok {
					return Record{}, StatusWait, nil
				}
				if err := r.openSegment(next); err != nil {
					return Record{}, StatusFail, err
				}
				continue
			}
			// Partial header at EOF.
			return r.tornOrWait("header")
		}
		if err != nil {
			return Record{}, StatusFail, err
		}
		if binary.LittleEndian.Uint16(hdr[0:2]) != magic {
			return Record{}, StatusFail, fmt.Errorf("tailer: segment %d offset %d: bad magic %#x",
				r.seg, r.off, binary.LittleEndian.Uint16(hdr[0:2]))
		}
		length := binary.LittleEndian.Uint32(hdr[2:6])
		if length > MaxPayload {
			return Record{}, StatusFail, fmt.Errorf("tailer: segment %d offset %d: payload length %d exceeds limit",
				r.seg, r.off, length)
		}

		payload := make([]byte, length)
		if length > 0 {
			n, err = r.f.ReadAt(payload, r.off+headerLen)
			if err == io.EOF && n < int(length) {
				return r.tornOrWait("payload")
			}
			if err != nil && err != io.EOF {
				return Record{}, StatusFail, err
			}
		}
		if crc32.ChecksumIEEE(payload) != binary.LittleEndian.Uint32(hdr[6:10]) {
			return Record{}, StatusFail, fmt.Errorf("tailer: segment %d offset %d: crc mismatch",
				r.seg, r.off)
		}

		rec := Record{Segment: r.seg, Offset: r.off, Payload: payload}
		r.off += headerLen + int64(length)
		return rec, StatusRecord, nil
	}
}

// tornOrWait decides whether a short read at the tail is an incomplete
// append (wait, cursor kept) or a record torn by rotation (fail).
func (r *Reader) tornOrWait(what string) (Record, Status, error) {
	_, ok, err := nextSegmentAfter(r.dir, r.seg)
	if err != nil {
		return Record{}, StatusFail, err
	}
	if ok {
		return Record{}, StatusFail, fmt.Errorf(
			"tailer: segment %d offset %d: record %s torn by rotation", r.seg, r.off, what)
	}
	return Record{}, StatusWait, nil
}
