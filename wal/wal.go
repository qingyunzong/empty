// Package wal implements a write-ahead log. Every record carries the
// before-image and after-image of the affected page plus the LSN of the
// transaction's previous record (its predecessor), forming the chain
// that undo walks. Compensation records (CLRs) make undo itself
// idempotent across crashes.
package wal

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
)

// RecType enumerates the kinds of log records.
type RecType byte

const (
	RecUpdate RecType = 1 + iota // page write: before/after images
	RecCommit                    // transaction committed
	RecAbort                     // transaction rolled back
	RecCLR                       // compensation record (redo-only undo step)
	RecEnd                       // transaction fully finished
)

// String returns a human-readable record type name.
func (t RecType) String() string {
	switch t {
	case RecUpdate:
		return "UPDATE"
	case RecCommit:
		return "COMMIT"
	case RecAbort:
		return "ABORT"
	case RecCLR:
		return "CLR"
	case RecEnd:
		return "END"
	default:
		return "UNKNOWN"
	}
}

// Record is a single log record.
type Record struct {
	LSN      uint64  // log sequence number, assigned by Log.Append
	PrevLSN  uint64  // predecessor: previous record of the same transaction (0 = none)
	TxID     uint64  // owning transaction
	Type     RecType // record kind
	PageID   uint32  // affected page (update/CLR only)
	UndoNext uint64  // CLR only: next record to undo on the chain
	Before   []byte  // before-image (update records)
	After    []byte  // after-image (update) / restored image (CLR)
}

const (
	frameHdr = 8 // 4-byte body length + 4-byte CRC32
	maxBody  = 1 << 22
	minBody  = 1 + 8 + 8 + 8 + 4 + 8 + 4 + 4
)

func encode(rec *Record) []byte {
	body := minBody + len(rec.Before) + len(rec.After)
	buf := make([]byte, frameHdr+body)
	payload := buf[frameHdr:]
	payload[0] = byte(rec.Type)
	off := 1
	binary.BigEndian.PutUint64(payload[off:], rec.LSN)
	off += 8
	binary.BigEndian.PutUint64(payload[off:], rec.PrevLSN)
	off += 8
	binary.BigEndian.PutUint64(payload[off:], rec.TxID)
	off += 8
	binary.BigEndian.PutUint32(payload[off:], rec.PageID)
	off += 4
	binary.BigEndian.PutUint64(payload[off:], rec.UndoNext)
	off += 8
	binary.BigEndian.PutUint32(payload[off:], uint32(len(rec.Before)))
	off += 4
	binary.BigEndian.PutUint32(payload[off:], uint32(len(rec.After)))
	off += 4
	copy(payload[off:], rec.Before)
	off += len(rec.Before)
	copy(payload[off:], rec.After)
	binary.BigEndian.PutUint32(buf, uint32(body))
	binary.BigEndian.PutUint32(buf[4:], crc32.ChecksumIEEE(payload))
	return buf
}

func decode(frame []byte) (*Record, error) {
	if len(frame) < frameHdr {
		return nil, errors.New("wal: short frame")
	}
	body := int(binary.BigEndian.Uint32(frame))
	if body < minBody || body > maxBody || len(frame) != frameHdr+body {
		return nil, errors.New("wal: bad frame length")
	}
	payload := frame[frameHdr:]
	if binary.BigEndian.Uint32(frame[4:]) != crc32.ChecksumIEEE(payload) {
		return nil, errors.New("wal: checksum mismatch")
	}
	rec := &Record{Type: RecType(payload[0])}
	off := 1
	rec.LSN = binary.BigEndian.Uint64(payload[off:])
	off += 8
	rec.PrevLSN = binary.BigEndian.Uint64(payload[off:])
	off += 8
	rec.TxID = binary.BigEndian.Uint64(payload[off:])
	off += 8
	rec.PageID = binary.BigEndian.Uint32(payload[off:])
	off += 4
	rec.UndoNext = binary.BigEndian.Uint64(payload[off:])
	off += 8
	blen := int(binary.BigEndian.Uint32(payload[off:]))
	off += 4
	alen := int(binary.BigEndian.Uint32(payload[off:]))
	off += 4
	if off+blen+alen != len(payload) {
		return nil, errors.New("wal: bad image lengths")
	}
	rec.Before = append([]byte(nil), payload[off:off+blen]...)
	rec.After = append([]byte(nil), payload[off+blen:off+blen+alen]...)
	return rec, nil
}

// Log appends records to a WAL file. Appended records are volatile until
// Sync; a crash (Close without Sync) loses them, which is exactly the
// durability boundary the recovery tests exercise.
type Log struct {
	f       *os.File
	nextLSN uint64
	pending [][]byte
}

// Open opens (or creates) the WAL file at path and positions the LSN
// counter after the last durable record.
func Open(path string) (*Log, error) {
	recs, err := Scan(path)
	if err != nil {
		return nil, err
	}
	var max uint64
	for _, r := range recs {
		if r.LSN > max {
			max = r.LSN
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Log{f: f, nextLSN: max + 1}, nil
}

// Append assigns the next LSN to rec and buffers it. The record becomes
// durable only after Sync.
func (l *Log) Append(rec *Record) uint64 {
	rec.LSN = l.nextLSN
	l.nextLSN++
	l.pending = append(l.pending, encode(rec))
	return rec.LSN
}

// Sync makes all buffered records durable.
func (l *Log) Sync() error {
	for _, p := range l.pending {
		if _, err := l.f.Write(p); err != nil {
			return err
		}
	}
	l.pending = l.pending[:0]
	return l.f.Sync()
}

// NextLSN returns the LSN the next Append will assign.
func (l *Log) NextLSN() uint64 { return l.nextLSN }

// Close closes the log file without syncing: buffered records are lost.
func (l *Log) Close() error { return l.f.Close() }

// Scan reads all durable records in path, stopping at (and ignoring) a
// torn or corrupt tail. A missing file yields no records.
func Scan(path string) ([]*Record, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var recs []*Record
	for len(data) >= frameHdr {
		body := int(binary.BigEndian.Uint32(data))
		if body <= 0 || body > maxBody || len(data) < frameHdr+body {
			break // torn tail
		}
		rec, err := decode(data[:frameHdr+body])
		if err != nil {
			break // corrupt tail
		}
		recs = append(recs, rec)
		data = data[frameHdr+body:]
	}
	return recs, nil
}
