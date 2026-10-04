package idalloc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrNotFound is returned by Storage.Read when the key does not exist.
var ErrNotFound = errors.New("idalloc: not found")

// ErrCrashed is returned by operations on an Allocator or Node whose
// storage generation advanced past the one the instance was opened in,
// i.e. the process it models died in a crash and must be reopened.
var ErrCrashed = errors.New("idalloc: instance belongs to a crashed generation")

// Storage is the minimal durable key-value contract the library relies on.
// Write stages data; it becomes durable only after Sync returns nil.
// Generation identifies the current storage incarnation and changes when
// unsynced data is discarded by a crash.
type Storage interface {
	Write(key string, data []byte) error
	Read(key string) ([]byte, error)
	Sync() error
	Generation() uint64
}

func validKey(key string) error {
	if key == "" || strings.ContainsAny(key, `/\`) || strings.Contains(key, "..") {
		return fmt.Errorf("idalloc: invalid storage key %q", key)
	}
	return nil
}

// FileStorage persists each key as a file in a directory. Write is atomic
// (temp file + fsync + rename); Sync fsyncs the directory itself.
type FileStorage struct {
	mu  sync.Mutex
	dir string
}

// NewFileStorage creates (if needed) a FileStorage rooted at dir.
func NewFileStorage(dir string) (*FileStorage, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &FileStorage{dir: dir}, nil
}

func (s *FileStorage) Write(key string, data []byte) error {
	if err := validKey(key); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp, err := os.CreateTemp(s.dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(s.dir, key))
}

func (s *FileStorage) Read(key string) ([]byte, error) {
	if err := validKey(key); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(s.dir, key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return data, err
}

func (s *FileStorage) Sync() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Generation is always 0 for FileStorage: a real process crash is modeled
// by simply not reusing the instance.
func (s *FileStorage) Generation() uint64 { return 0 }

// CrashStorage is an in-memory Storage with fault injection. Writes stage
// into a pending buffer (the page cache); Sync moves them to committed
// (durable) storage. Crash discards pending data and bumps the generation,
// modeling power loss. Reads see pending+committed, like a live OS.
type CrashStorage struct {
	mu        sync.Mutex
	committed map[string][]byte
	pending   map[string][]byte
	gen       uint64

	failWrites int    // next N Write calls return an error
	crashAfter int    // crash after N more writes; -1 = disarmed
	OnCrash    func() // invoked (under lock) when a crash fires
}

func NewCrashStorage() *CrashStorage {
	return &CrashStorage{
		committed:  make(map[string][]byte),
		pending:    make(map[string][]byte),
		crashAfter: -1,
	}
}

func (s *CrashStorage) Write(key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWrites > 0 {
		s.failWrites--
		return errors.New("idalloc: injected write failure")
	}
	s.pending[key] = append([]byte(nil), data...)
	if s.crashAfter > 0 {
		s.crashAfter--
		if s.crashAfter == 0 {
			s.crashAfter = -1
			s.crashLocked()
		}
	}
	return nil
}

func (s *CrashStorage) Read(key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if data, ok := s.pending[key]; ok {
		return append([]byte(nil), data...), nil
	}
	if data, ok := s.committed[key]; ok {
		return append([]byte(nil), data...), nil
	}
	return nil, ErrNotFound
}

func (s *CrashStorage) Sync() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.pending {
		s.committed[k] = v
	}
	s.pending = make(map[string][]byte)
	return nil
}

// Crash drops all unsynced writes and advances the storage generation.
func (s *CrashStorage) Crash() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crashLocked()
}

func (s *CrashStorage) crashLocked() {
	s.pending = make(map[string][]byte)
	s.gen++
	if s.OnCrash != nil {
		s.OnCrash()
	}
}

func (s *CrashStorage) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// ArmFailWrites makes the next n Write calls fail with an error.
func (s *CrashStorage) ArmFailWrites(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failWrites = n
}

// ArmCrashAfterWrites triggers a crash after n more successful writes,
// landing faults in the middle of persist sequences.
func (s *CrashStorage) ArmCrashAfterWrites(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crashAfter = n
}
