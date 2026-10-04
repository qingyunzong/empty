// Package replayfs is a test library that records file-interface calls
// (operation, arguments, return values, persistence points) into a trace,
// and replays traces with strict item-by-item verification.
package replayfs

import (
	"errors"
	"io"
	"sync"
)

// Store is durable storage: path -> committed bytes.
type Store struct {
	mu   sync.Mutex
	data map[string][]byte
}

// NewStore returns an empty durable store.
func NewStore() *Store { return &Store{data: make(map[string][]byte)} }

func (s *Store) commit(path string, p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[path] = append(s.data[path], p...)
}

func (s *Store) load(path string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.data[path]...)
}

// Equal reports whether two stores hold identical contents.
func (s *Store) Equal(other *Store) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	other.mu.Lock()
	defer other.mu.Unlock()
	if len(s.data) != len(other.data) {
		return false
	}
	for path, a := range s.data {
		b, ok := other.data[path]
		if !ok || string(a) != string(b) {
			return false
		}
	}
	return true
}

// FS is an append-only file system whose writes are buffered in memory
// until Sync or Close commits them to the durable Store.
type FS struct{ store *Store }

// NewFS returns a file system backed by store.
func NewFS(store *Store) *FS { return &FS{store: store} }

// Store exposes the durable store backing fs.
func (fs *FS) Store() *Store { return fs.store }

// Open opens path for appending and reading.
func (fs *FS) Open(path string) (*File, error) {
	return &File{fs: fs, path: path}, nil
}

// File is a buffered append-only file handle.
type File struct {
	fs     *FS
	path   string
	buf    []byte
	off    int
	closed bool
}

// ErrClosed is returned by operations on a closed file.
var ErrClosed = errors.New("replayfs: file already closed")

// Write buffers p; bytes become durable only at Sync or Close.
func (f *File) Write(p []byte) (int, error) {
	if f.closed {
		return 0, ErrClosed
	}
	f.buf = append(f.buf, p...)
	return len(p), nil
}

// Read reads from committed bytes plus pending buffered writes.
func (f *File) Read(p []byte) (int, error) {
	if f.closed {
		return 0, ErrClosed
	}
	content := append(f.fs.store.load(f.path), f.buf...)
	if f.off >= len(content) {
		return 0, io.EOF
	}
	n := copy(p, content[f.off:])
	f.off += n
	return n, nil
}

// Sync commits buffered writes to the durable store. It is a
// persistence point.
func (f *File) Sync() error {
	if f.closed {
		return ErrClosed
	}
	f.fs.store.commit(f.path, f.buf)
	f.buf = nil
	return nil
}

// Close flushes pending writes (a persistence point) and closes the file.
func (f *File) Close() error {
	if f.closed {
		return ErrClosed
	}
	if err := f.Sync(); err != nil {
		return err
	}
	f.closed = true
	return nil
}
