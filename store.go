package dataeng

import (
	"encoding/json"
	"io"
	"os"
	"sync"
)

// LogKind identifies the kind of a WAL record.
type LogKind string

const (
	KindEvent    LogKind = "event"
	KindSnapshot LogKind = "snapshot"
)

// LogRecord is one WAL entry. Inputs are logged before their effects are
// applied in memory, so replaying the log deterministically rebuilds the
// exact same state and outbound sequence.
type LogRecord struct {
	Kind     LogKind   `json:"kind"`
	Event    *Event    `json:"event,omitempty"`
	Snapshot *Snapshot `json:"snapshot,omitempty"`
}

// Store persists the reconciler WAL.
type Store interface {
	Append(rec LogRecord) error
	Replay(fn func(LogRecord) error) error
}

// MemStore is an in-memory Store, useful for tests and ephemeral setups.
type MemStore struct {
	mu   sync.Mutex
	recs []LogRecord
}

func NewMemStore() *MemStore { return &MemStore{} }

func (s *MemStore) Append(rec LogRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recs = append(s.recs, rec)
	return nil
}

func (s *MemStore) Replay(fn func(LogRecord) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range s.recs {
		if err := fn(rec); err != nil {
			return err
		}
	}
	return nil
}

// FileStore is a WAL backed by an append-only JSON-lines file. Every append
// is fsynced before HandleEvent/HandleSnapshot return. A torn tail left by a
// crash mid-write is truncated on replay.
type FileStore struct {
	mu sync.Mutex
	f  *os.File
}

func NewFileStore(path string) (*FileStore, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &FileStore{f: f}, nil
}

func (s *FileStore) Append(rec LogRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if _, err := s.f.Write(append(b, '\n')); err != nil {
		return err
	}
	return s.f.Sync()
}

func (s *FileStore) Replay(fn func(LogRecord) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var good int64
	dec := json.NewDecoder(s.f)
	for {
		var rec LogRecord
		err := dec.Decode(&rec)
		if err != nil {
			// io.EOF: clean end. Anything else: torn tail from a crash.
			break
		}
		if err := fn(rec); err != nil {
			return err
		}
		good = dec.InputOffset()
	}
	if err := s.f.Truncate(good); err != nil {
		return err
	}
	_, err := s.f.Seek(0, io.SeekEnd)
	return err
}

func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.f.Close()
}
