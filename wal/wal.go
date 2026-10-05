// Package wal implements a write-ahead log. Each record carries its LSN,
// the previous LSN of the same transaction (the transaction predecessor
// chain), and for updates the before and after images of the modified
// byte range. The log tolerates a torn tail: scanning stops at the first
// incomplete or corrupt record.
package wal

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
)

// Record types.
const (
	RecUpdate uint8 = 1 // physiological update: before/after images
	RecCommit uint8 = 2
	RecAbort  uint8 = 3
	RecCLR    uint8 = 4 // compensation log record written by undo
	RecEnd    uint8 = 5 // transaction fully finished
)

// NullLSN terminates a transaction's prev-LSN chain.
const NullLSN int64 = 0

// magic occupies the first 8 bytes of the log file, so the first real
// record has LSN 8 and LSN 0 can serve as the null pointer.
var magic = []byte("PSTWAL01")

const headerLen = 8 + 1 + 8 + 8 + 8 + 4 + 4 + 4 + 8 // 53 bytes
const crcLen = 4

// Record is a single log record. For RecUpdate, Before and After hold the
// images of the PageID range starting at Offset. For RecCLR, After holds
// the image restored by undo and UndoNextLSN points to the next record of
// the transaction still to undo.
type Record struct {
	LSN         int64
	Type        uint8
	TxnID       uint64
	PrevLSN     int64
	PageID      uint64
	Offset      uint32
	Before      []byte
	After       []byte
	UndoNextLSN int64
}

func (r *Record) encodedLen() int {
	return headerLen + crcLen + len(r.Before) + len(r.After)
}

func (r *Record) encode() []byte {
	buf := make([]byte, r.encodedLen())
	binary.LittleEndian.PutUint64(buf[0:8], uint64(r.LSN))
	buf[8] = r.Type
	binary.LittleEndian.PutUint64(buf[9:17], r.TxnID)
	binary.LittleEndian.PutUint64(buf[17:25], uint64(r.PrevLSN))
	binary.LittleEndian.PutUint64(buf[25:33], r.PageID)
	binary.LittleEndian.PutUint32(buf[33:37], r.Offset)
	binary.LittleEndian.PutUint32(buf[37:41], uint32(len(r.Before)))
	binary.LittleEndian.PutUint32(buf[41:45], uint32(len(r.After)))
	binary.LittleEndian.PutUint64(buf[45:53], uint64(r.UndoNextLSN))
	pos := headerLen
	copy(buf[pos:], r.Before)
	pos += len(r.Before)
	copy(buf[pos:], r.After)
	pos += len(r.After)
	binary.LittleEndian.PutUint32(buf[pos:pos+crcLen], crc32.ChecksumIEEE(buf[:pos]))
	return buf
}

// decode parses one record from buf, returning the record and the number
// of bytes consumed. It fails on truncated or corrupt input.
func decode(buf []byte) (*Record, int, error) {
	if len(buf) < headerLen+crcLen {
		return nil, 0, fmt.Errorf("wal: short header")
	}
	r := &Record{
		LSN:         int64(binary.LittleEndian.Uint64(buf[0:8])),
		Type:        buf[8],
		TxnID:       binary.LittleEndian.Uint64(buf[9:17]),
		PrevLSN:     int64(binary.LittleEndian.Uint64(buf[17:25])),
		PageID:      binary.LittleEndian.Uint64(buf[25:33]),
		Offset:      binary.LittleEndian.Uint32(buf[33:37]),
		UndoNextLSN: int64(binary.LittleEndian.Uint64(buf[45:53])),
	}
	beforeLen := int(binary.LittleEndian.Uint32(buf[37:41]))
	dataLen := int(binary.LittleEndian.Uint32(buf[41:45]))
	if beforeLen > 1<<20 || dataLen > 1<<20 {
		return nil, 0, fmt.Errorf("wal: implausible data length %d/%d", beforeLen, dataLen)
	}
	total := headerLen + beforeLen + dataLen + crcLen
	if len(buf) < total {
		return nil, 0, fmt.Errorf("wal: truncated record")
	}
	pos := headerLen
	r.Before = append([]byte(nil), buf[pos:pos+beforeLen]...)
	pos += beforeLen
	r.After = append([]byte(nil), buf[pos:pos+dataLen]...)
	pos += dataLen
	want := binary.LittleEndian.Uint32(buf[pos : pos+crcLen])
	if crc32.ChecksumIEEE(buf[:pos]) != want {
		return nil, 0, fmt.Errorf("wal: crc mismatch at lsn %d", r.LSN)
	}
	return r, total, nil
}

// Log appends records to a log file. Appends are staged in memory and
// become durable only on Flush, which models the commit/flush boundary.
type Log struct {
	f           *os.File
	nextLSN     int64
	flushedUpTo int64
	pending     []byte
	records     map[int64]*Record // all valid records, flushed or not
}

// Open opens (or creates) the log file at path and scans any existing
// records so that LSN allocation continues where the file ends.
func Open(path string) (*Log, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("wal: open %s: %w", path, err)
	}
	l := &Log{f: f, records: make(map[int64]*Record)}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if info.Size() == 0 {
		if _, err := f.WriteAt(magic, 0); err != nil {
			f.Close()
			return nil, fmt.Errorf("wal: write magic: %w", err)
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return nil, err
		}
		l.nextLSN = int64(len(magic))
		l.flushedUpTo = l.nextLSN
		return l, nil
	}
	recs, err := l.Scan()
	if err != nil {
		f.Close()
		return nil, err
	}
	end := int64(len(magic))
	for _, r := range recs {
		l.records[r.LSN] = r
		end = r.LSN + int64(r.encodedLen())
	}
	l.nextLSN = end
	l.flushedUpTo = end
	return l, nil
}

// Append assigns the record's LSN and stages it. The record is durable
// only after Flush.
func (l *Log) Append(r *Record) int64 {
	r.LSN = l.nextLSN
	enc := r.encode()
	l.pending = append(l.pending, enc...)
	l.records[r.LSN] = r
	l.nextLSN += int64(len(enc))
	return r.LSN
}

// Flush makes all staged records durable.
func (l *Log) Flush() error {
	if len(l.pending) == 0 {
		return nil
	}
	if _, err := l.f.WriteAt(l.pending, l.flushedUpTo); err != nil {
		return fmt.Errorf("wal: flush: %w", err)
	}
	if err := l.f.Sync(); err != nil {
		return fmt.Errorf("wal: sync: %w", err)
	}
	l.flushedUpTo = l.nextLSN
	l.pending = nil
	return nil
}

// FlushedLSN returns the LSN boundary up to which the log is durable.
func (l *Log) FlushedLSN() int64 { return l.flushedUpTo }

// Lookup returns the record with the given LSN, or nil.
func (l *Log) Lookup(lsn int64) *Record { return l.records[lsn] }

// Scan reads all valid records from the file, stopping at the first
// incomplete or corrupt record (a torn tail left by a crash).
func (l *Log) Scan() ([]*Record, error) {
	info, err := l.f.Stat()
	if err != nil {
		return nil, err
	}
	buf := make([]byte, info.Size())
	if _, err := l.f.ReadAt(buf, 0); err != nil && info.Size() > 0 {
		return nil, fmt.Errorf("wal: read: %w", err)
	}
	if len(buf) < len(magic) || string(buf[:len(magic)]) != string(magic) {
		return nil, fmt.Errorf("wal: bad magic")
	}
	var recs []*Record
	pos := len(magic)
	for pos < len(buf) {
		r, n, err := decode(buf[pos:])
		if err != nil {
			break // torn or corrupt tail: everything before it is valid
		}
		recs = append(recs, r)
		pos += n
	}
	return recs, nil
}

// DiscardPending drops staged but unflushed records, simulating a crash.
// In-memory index state is rebuilt from the durable file contents.
func (l *Log) DiscardPending() error {
	l.pending = nil
	l.nextLSN = l.flushedUpTo
	recs, err := l.Scan()
	if err != nil {
		return err
	}
	l.records = make(map[int64]*Record)
	for _, r := range recs {
		l.records[r.LSN] = r
	}
	return nil
}

// Close closes the log file without flushing staged records.
func (l *Log) Close() error { return l.f.Close() }
