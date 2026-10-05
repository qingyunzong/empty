package auditlog

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// On-disk frame layout (all integers big-endian):
//
//	uint32  length of serialized record body
//	[]byte  serialized record body
//	[32]byte SHA-256 of the length prefix and body
//
// A crash mid-write leaves a torn trailing frame. Open scans frames,
// verifies each checksum, and truncates the file at the first bad or
// incomplete frame, so a recovered log always contains only fully
// committed records.
const (
	lenPrefixSize = 4
	checksumSize  = sha256.Size
)

// Log is an append-only, file-backed audit log.
type Log struct {
	f       *os.File
	path    string
	records []Record
	prev    [sha256.Size]byte
}

// Open opens (or creates) the log at path and recovers from any torn
// trailing write left by a crash.
func Open(path string) (*Log, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	l := &Log{f: f, path: path}
	if err := l.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return l, nil
}

// recover scans all frames, truncates any torn tail, and rebuilds the
// in-memory record index.
func (l *Log) recover() error {
	if _, err := l.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var good int64 // offset just past the last valid frame
	for {
		frame, err := readFrame(l.f)
		if err == io.EOF {
			break // clean end of log
		}
		if err == io.ErrUnexpectedEOF || err == errBadChecksum {
			break // torn or corrupt tail: truncate below
		}
		if err != nil {
			return fmt.Errorf("scanning log: %w", err)
		}
		rec, err := decodeRecord(frame)
		if err != nil {
			return fmt.Errorf("decoding record %d: %w", len(l.records), err)
		}
		l.records = append(l.records, *rec)
		l.prev = rec.Hash
		pos, err := l.f.Seek(0, io.SeekCurrent)
		if err != nil {
			return err
		}
		good = pos
	}
	if err := l.f.Truncate(good); err != nil {
		return fmt.Errorf("truncating torn tail: %w", err)
	}
	if _, err := l.f.Seek(good, io.SeekStart); err != nil {
		return err
	}
	return l.f.Sync()
}

var errBadChecksum = fmt.Errorf("frame checksum mismatch")

func readFrame(r io.Reader) ([]byte, error) {
	var lenBuf [lenPrefixSize]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		if err == io.EOF {
			return nil, io.EOF
		}
		return nil, io.ErrUnexpectedEOF
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, io.ErrUnexpectedEOF
	}
	var sum [checksumSize]byte
	if _, err := io.ReadFull(r, sum[:]); err != nil {
		return nil, io.ErrUnexpectedEOF
	}
	h := sha256.New()
	h.Write(lenBuf[:])
	h.Write(body)
	if !bytes.Equal(h.Sum(nil), sum[:]) {
		return nil, errBadChecksum
	}
	return body, nil
}

func writeFrame(w io.Writer, body []byte) error {
	var lenBuf [lenPrefixSize]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(body)))
	h := sha256.New()
	h.Write(lenBuf[:])
	h.Write(body)
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	if _, err := w.Write(body); err != nil {
		return err
	}
	_, err := w.Write(h.Sum(nil))
	return err
}

// Append redacts payload over the given ranges and commits a new record.
// The record is fsynced before Append returns; the original payload is
// never written to disk.
func (l *Log) Append(payload []byte, ranges []Range) (*Record, error) {
	redacted, merged, err := Redact(payload, ranges)
	if err != nil {
		return nil, err
	}
	rec := NewRecord(uint64(len(l.records)), l.prev, Digest(payload), redacted, merged)
	body := encodeRecord(rec)
	if err := writeFrame(l.f, body); err != nil {
		return nil, fmt.Errorf("writing record %d: %w", rec.Index, err)
	}
	if err := l.f.Sync(); err != nil {
		return nil, fmt.Errorf("syncing record %d: %w", rec.Index, err)
	}
	l.records = append(l.records, *rec)
	l.prev = rec.Hash
	out := *rec
	return &out, nil
}

// Records returns a copy of all committed records.
func (l *Log) Records() []Record {
	return append([]Record(nil), l.records...)
}

// Verify replays the hash chain over all committed records.
func (l *Log) Verify() error {
	return VerifyChain(l.records)
}

// Close closes the underlying file.
func (l *Log) Close() error {
	return l.f.Close()
}

func encodeRecord(r *Record) []byte {
	var buf bytes.Buffer
	var tmp [8]byte
	binary.BigEndian.PutUint64(tmp[:], r.Index)
	buf.Write(tmp[:])
	buf.Write(r.PrevHash[:])
	buf.Write(r.OrigDigest[:])
	binary.BigEndian.PutUint64(tmp[:], uint64(len(r.Ranges)))
	buf.Write(tmp[:])
	for _, rg := range r.Ranges {
		binary.BigEndian.PutUint64(tmp[:], uint64(rg.Start))
		buf.Write(tmp[:])
		binary.BigEndian.PutUint64(tmp[:], uint64(rg.End))
		buf.Write(tmp[:])
	}
	binary.BigEndian.PutUint64(tmp[:], uint64(len(r.Payload)))
	buf.Write(tmp[:])
	buf.Write(r.Payload)
	buf.Write(r.Hash[:])
	return buf.Bytes()
}

func decodeRecord(body []byte) (*Record, error) {
	br := bytes.NewReader(body)
	readU64 := func() (uint64, error) {
		var tmp [8]byte
		if _, err := io.ReadFull(br, tmp[:]); err != nil {
			return 0, err
		}
		return binary.BigEndian.Uint64(tmp[:]), nil
	}
	r := &Record{}
	var err error
	if r.Index, err = readU64(); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(br, r.PrevHash[:]); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(br, r.OrigDigest[:]); err != nil {
		return nil, err
	}
	nRanges, err := readU64()
	if err != nil {
		return nil, err
	}
	if nRanges > 1<<20 {
		return nil, fmt.Errorf("implausible range count %d", nRanges)
	}
	for i := uint64(0); i < nRanges; i++ {
		s, err := readU64()
		if err != nil {
			return nil, err
		}
		e, err := readU64()
		if err != nil {
			return nil, err
		}
		r.Ranges = append(r.Ranges, Range{Start: int(s), End: int(e)})
	}
	nPayload, err := readU64()
	if err != nil {
		return nil, err
	}
	if nPayload > 1<<32 {
		return nil, fmt.Errorf("implausible payload size %d", nPayload)
	}
	r.Payload = make([]byte, nPayload)
	if _, err = io.ReadFull(br, r.Payload); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(br, r.Hash[:]); err != nil {
		return nil, err
	}
	if br.Len() != 0 {
		return nil, fmt.Errorf("%d trailing bytes in record body", br.Len())
	}
	return r, nil
}
