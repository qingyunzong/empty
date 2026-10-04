package cover

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// Deltas are persisted to an append-only write-ahead log so a store
// can be recovered after a crash. Each record is framed as:
//
//	uint32 payload length (big-endian)
//	payload: JSON-encoded Delta
//	uint32 CRC-32 (IEEE) of the payload
//
// Recovery reads every complete, checksum-valid record and stops at
// the first torn or corrupt tail, which can only be the suffix left
// behind by an interrupted write.

const walHeaderSize = 4

func encodeRecord(d Delta) ([]byte, error) {
	payload, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	rec := make([]byte, 0, walHeaderSize+len(payload)+4)
	rec = binary.BigEndian.AppendUint32(rec, uint32(len(payload)))
	rec = append(rec, payload...)
	rec = binary.BigEndian.AppendUint32(rec, crc32.ChecksumIEEE(payload))
	return rec, nil
}

// ReadWAL returns every complete, checksum-valid delta recorded in
// the file at path, in append order. A missing file yields no deltas.
// A torn or corrupt tail (from a crash mid-write) is ignored.
func ReadWAL(path string) ([]Delta, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []Delta
	for {
		var hdr [walHeaderSize]byte
		if _, err := io.ReadFull(f, hdr[:]); err != nil {
			break // clean EOF or torn header
		}
		n := binary.BigEndian.Uint32(hdr[:])
		buf := make([]byte, n+4)
		if _, err := io.ReadFull(f, buf); err != nil {
			break // torn payload or checksum
		}
		payload, sum := buf[:n], binary.BigEndian.Uint32(buf[n:])
		if crc32.ChecksumIEEE(payload) != sum {
			break // corrupt record: stop replay here
		}
		var d Delta
		if err := json.Unmarshal(payload, &d); err != nil {
			break
		}
		out = append(out, d)
	}
	return out, nil
}

// Log is a Store backed by a WAL file: every applied merge is
// appended and synced before the in-memory state changes, so
// reopening the file replays exactly the durable history.
type Log struct {
	store *Store
	f     *os.File
}

// Open opens (creating if needed) the WAL at path, replays its
// records into a fresh store bound to digest d, and returns the Log
// ready for new merges. Records whose digest does not match d are
// rejected during replay, so a log is never mixed across sources.
func Open(path string, d Digest) (*Log, error) {
	deltas, err := ReadWAL(path)
	if err != nil {
		return nil, err
	}
	store := NewStore(d)
	for _, delta := range deltas {
		if _, err := store.Merge(delta); err != nil {
			return nil, fmt.Errorf("cover: replay %s: %w", path, err)
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Log{store: store, f: f}, nil
}

// Store returns the in-memory store reconstructed from the log.
func (l *Log) Store() *Store { return l.store }

// Merge validates d, appends it to the log, syncs, and only then
// applies it to the in-memory store. Duplicate run IDs and invalid
// deltas are never written, so the log stays idempotent under replay.
func (l *Log) Merge(d Delta) (bool, error) {
	ok, err := l.store.check(d)
	if err != nil || !ok {
		return ok, err
	}
	rec, err := encodeRecord(d)
	if err != nil {
		return false, err
	}
	if _, err := l.f.Write(rec); err != nil {
		return false, err
	}
	if err := l.f.Sync(); err != nil {
		return false, err
	}
	l.store.apply(d)
	return true, nil
}

// Close flushes and closes the underlying log file.
func (l *Log) Close() error {
	if err := l.f.Sync(); err != nil {
		return err
	}
	return l.f.Close()
}
