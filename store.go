package formal

import (
	"fmt"
	"io"
	"os"
	"sync"
)

// Store is the durable byte sink used by Coordinator. The coordinator writes
// complete, checksummed frames, but Store.Append must be treated as a prefix
// operation: a crash may leave any prefix of the supplied bytes durable.
//
// Append must sync before returning nil. If it returns an error, the
// coordinator refuses further writes until it is reopened; reopening replays
// the valid prefix and truncates a torn tail.
type Store interface {
	Append(p []byte) error
	Read() ([]byte, error)
	Truncate(size int64) error
}

// MemoryStore is an in-memory Store for tests and embedded, non-durable uses.
type MemoryStore struct {
	mu  sync.Mutex
	buf []byte
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Append implements Store.
func (s *MemoryStore) Append(p []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf = append(s.buf, p...)
	return nil
}

// Read implements Store.
func (s *MemoryStore) Read() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.buf...), nil
}

// Truncate implements Store.
func (s *MemoryStore) Truncate(size int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if size < 0 || size > int64(len(s.buf)) {
		return fmt.Errorf("formal: truncate %d beyond %d bytes", size, len(s.buf))
	}
	s.buf = append([]byte(nil), s.buf[:int(size)]...)
	return nil
}

// Len returns the current number of stored bytes.
func (s *MemoryStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.buf)
}

// FileStore is an append-only file backed Store. Each Append is followed by
// fsync before success is reported.
type FileStore struct {
	mu   sync.Mutex
	file *os.File
}

// OpenFileStore opens or creates path for append-only storage.
func OpenFileStore(path string) (*FileStore, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("formal: open store %q: %w", path, err)
	}
	return &FileStore{file: f}, nil
}

// Append implements Store.
func (s *FileStore) Append(p []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return os.ErrClosed
	}
	for len(p) > 0 {
		n, err := s.file.Write(p)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return s.file.Sync()
}

// Read implements Store.
func (s *FileStore) Read() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil, os.ErrClosed
	}
	info, err := s.file.Stat()
	if err != nil {
		return nil, err
	}
	buf := make([]byte, info.Size())
	if len(buf) == 0 {
		return buf, nil
	}
	n, err := s.file.ReadAt(buf, 0)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if int64(n) != info.Size() {
		return nil, io.ErrUnexpectedEOF
	}
	return buf, nil
}

// Truncate implements Store.
func (s *FileStore) Truncate(size int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return os.ErrClosed
	}
	if err := s.file.Truncate(size); err != nil {
		return err
	}
	return s.file.Sync()
}

// Close closes the underlying file.
func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}
