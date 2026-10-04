package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"strconv"
)

// Record kinds stored in the journal.
const (
	KindSession    = "session"
	KindTransition = "transition"
)

// Record is one journaled entry. The first record of a journal is always a
// KindSession header; every following record is a KindTransition.
type Record struct {
	Kind            string `json:"kind"`
	Session         string `json:"session"`
	Seq             int    `json:"seq,omitempty"`
	Key             string `json:"key,omitempty"`
	Action          string `json:"action,omitempty"`
	From            string `json:"from,omitempty"`
	To              string `json:"to,omitempty"`
	ExpiresUnixNano int64  `json:"expires_unix_nano,omitempty"`
}

// Device is the durable medium underneath a Store. Append stages bytes in
// volatile storage; only Sync makes them durable. A crash between Append
// and Sync loses the staged bytes.
type Device interface {
	ReadAll() ([]byte, error)
	Append(p []byte) error
	Sync() error
	Truncate(size int64) error
}

// FileDevice is a Device backed by an os.File.
type FileDevice struct {
	f *os.File
}

// OpenFileDevice opens (or creates) the journal file at path.
func OpenFileDevice(path string) (*FileDevice, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	return &FileDevice{f: f}, nil
}

// ReadAll reads the whole file.
func (d *FileDevice) ReadAll() ([]byte, error) {
	if _, err := d.f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(d.f)
}

// Append writes p at the end of the file.
func (d *FileDevice) Append(p []byte) error {
	if _, err := d.f.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	_, err := d.f.Write(p)
	return err
}

// Sync flushes the file to durable storage.
func (d *FileDevice) Sync() error { return d.f.Sync() }

// Truncate shrinks the file to size bytes.
func (d *FileDevice) Truncate(size int64) error { return d.f.Truncate(size) }

// Close closes the underlying file.
func (d *FileDevice) Close() error { return d.f.Close() }

// Store is an append-only journal of checksummed records. On open it
// recovers from torn tails left by a crash mid-write by truncating the
// device back to the last valid record.
type Store struct {
	dev     Device
	records []Record
	size    int64
}

// OpenStore replays the journal on dev, truncating any incomplete or
// corrupt tail left by an interrupted write.
func OpenStore(dev Device) (*Store, error) {
	data, err := dev.ReadAll()
	if err != nil {
		return nil, err
	}
	recs, valid := parseJournal(data)
	if valid < int64(len(data)) {
		if err := dev.Truncate(valid); err != nil {
			return nil, err
		}
	}
	return &Store{dev: dev, records: recs, size: valid}, nil
}

// Append persists one record: the bytes are written and synced to durable
// storage before Append returns.
func (s *Store) Append(rec Record) error {
	line := encodeRecord(rec)
	if err := s.dev.Append(line); err != nil {
		return err
	}
	if err := s.dev.Sync(); err != nil {
		return err
	}
	s.records = append(s.records, rec)
	s.size += int64(len(line))
	return nil
}

// Records returns the journaled records in order.
func (s *Store) Records() []Record {
	return append([]Record(nil), s.records...)
}

func encodeRecord(rec Record) []byte {
	payload, err := json.Marshal(rec)
	if err != nil {
		panic(err)
	}
	return []byte(fmt.Sprintf("%08x %s\n", crc32.ChecksumIEEE(payload), payload))
}

// parseJournal decodes as many records as possible and reports the offset
// of the first byte not covered by a valid record.
func parseJournal(data []byte) ([]Record, int64) {
	var recs []Record
	var off int64
	for off < int64(len(data)) {
		nl := bytes.IndexByte(data[off:], '\n')
		if nl < 0 {
			break // incomplete tail from a torn write
		}
		rec, ok := decodeLine(data[off : off+int64(nl)])
		if !ok {
			break // corrupt tail
		}
		recs = append(recs, rec)
		off += int64(nl) + 1
	}
	return recs, off
}

func decodeLine(line []byte) (Record, bool) {
	sp := bytes.IndexByte(line, ' ')
	if sp != 8 {
		return Record{}, false
	}
	sum, err := strconv.ParseUint(string(line[:sp]), 16, 32)
	if err != nil {
		return Record{}, false
	}
	payload := line[sp+1:]
	if crc32.ChecksumIEEE(payload) != uint32(sum) {
		return Record{}, false
	}
	var rec Record
	if err := json.Unmarshal(payload, &rec); err != nil {
		return Record{}, false
	}
	return rec, true
}
