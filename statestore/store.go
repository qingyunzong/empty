// Package statestore implements a versioned concurrent state store with
// write-ahead logging. Updates are compare-and-swap on an expected version;
// a successful update is persisted (append + fsync) before it becomes
// visible, and recovery replays only complete commit frames.
package statestore

import (
	"errors"
	"io"
	"os"
	"sync"
)

// ErrVersionMismatch is returned when the caller's expected version does not
// match the store's current version.
var ErrVersionMismatch = errors.New("statestore: version mismatch")

// syncFile is the subset of *os.File the store needs for its WAL. Tests
// inject faulty implementations to simulate short writes and crashes.
type syncFile interface {
	Write(p []byte) (int, error)
	Sync() error
	Close() error
}

// Store is a concurrency-safe, WAL-backed versioned state cell.
type Store struct {
	mu      sync.Mutex
	version uint64
	value   []byte
	wal     syncFile
	path    string
}

// Open (re)opens the store at path, replaying every complete commit frame in
// the log. Incomplete or corrupted trailing frames from a crash are ignored.
func Open(path string) (*Store, error) {
	rf, err := os.Open(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var records []record
	if rf != nil {
		records, err = replay(rf)
		rf.Close()
		if err != nil {
			return nil, err
		}
	}
	wf, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	s := &Store{wal: wf, path: path}
	if len(records) > 0 {
		last := records[len(records)-1]
		s.version = last.version
		s.value = append([]byte(nil), last.payload...)
	}
	return s, nil
}

// Get returns the current version and value.
func (s *Store) Get() (uint64, []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.version, append([]byte(nil), s.value...)
}

// Update applies value only if expected equals the current version. The
// commit frame is appended and fsynced before the new state becomes visible;
// a short write or sync failure leaves the store untouched and unpublished.
// On success it returns the new version (expected+1).
func (s *Store) Update(expected uint64, value []byte) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.version != expected {
		return s.version, ErrVersionMismatch
	}
	next := s.version + 1
	if err := appendFrame(s.wal, encodeFrame(next, value)); err != nil {
		return s.version, err
	}
	s.version = next
	s.value = append([]byte(nil), value...)
	return next, nil
}

// appendFrame writes the whole frame and fsyncs it. A short write is
// reported as io.ErrShortWrite so callers never publish partial commits.
func appendFrame(f syncFile, frame []byte) error {
	n, err := f.Write(frame)
	if err == nil && n != len(frame) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return err
	}
	return f.Sync()
}

// Close closes the underlying log file.
func (s *Store) Close() error {
	return s.wal.Close()
}
