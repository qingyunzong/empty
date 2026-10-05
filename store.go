// Package backupupload implements the backup-side upload library.
//
// Chunks of a backup object may arrive out of order and may overlap;
// overlapping bytes must be identical or the write is rejected. A
// commit validates coverage and content hash, fsyncs the staged file,
// and only then publishes it with an atomic rename, so concurrent
// readers keep reading either the complete old version or the
// complete new version. Staging files left behind by a crash are
// removed by Recover, never published.
package backupupload

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

var (
	// ErrOverlapConflict is returned when a chunk overlaps previously
	// written bytes and the overlapping bytes differ.
	ErrOverlapConflict = errors.New("backupupload: overlapping bytes differ")
	// ErrIncomplete is returned by Commit when the uploaded chunks do
	// not cover the declared object size.
	ErrIncomplete = errors.New("backupupload: chunks do not cover declared size")
	// ErrHashMismatch is returned by Commit when the staged content
	// hash does not match the expected hash.
	ErrHashMismatch = errors.New("backupupload: content hash mismatch")
	// ErrNotFound is returned when reading an object that does not exist.
	ErrNotFound = errors.New("backupupload: object not found")
)

const stagingSuffix = ".staging"

// Store is a directory-backed object store with staged uploads.
type Store struct {
	dir    string
	Faults FaultInjector

	mu       sync.Mutex
	sessions map[string]*Session
}

// Open creates (or reuses) a store rooted at dir. It does not remove
// staging files; call Recover to clean up after a crash.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{dir: dir, sessions: make(map[string]*Session)}, nil
}

// Recover removes leftover staging files. Because a commit publishes
// with an atomic rename only after all chunks are validated and
// synced, any staging file present at recovery time belongs to an
// incomplete upload and is discarded. The published object is
// therefore always either the complete old version or the complete
// new version.
func (s *Store) Recover() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), stagingSuffix) {
			if err := os.Remove(filepath.Join(s.dir, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) finalPath(name string) string {
	return filepath.Join(s.dir, name)
}

func (s *Store) stagingPath(name string) string {
	return filepath.Join(s.dir, name+stagingSuffix)
}

// Read returns the current published content of name. A reader that
// opens the object before a concurrent commit keeps reading the old
// version; a reader that opens it after observes the new version.
func (s *Store) Read(name string) ([]byte, error) {
	b, err := os.ReadFile(s.finalPath(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

// OpenReader opens the published object for reading. The returned
// file keeps referring to the version that was current at open time,
// even if a later commit atomically replaces it.
func (s *Store) OpenReader(name string) (*os.File, error) {
	f, err := os.Open(s.finalPath(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

// Begin starts an upload session for name. Chunks are staged in a
// sidecar file and only published by Commit.
func (s *Store) Begin(name string) (*Session, error) {
	if strings.Contains(name, "/") || name == "" || name == "." || name == ".." {
		return nil, fmt.Errorf("backupupload: invalid object name %q", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[name]; ok {
		return nil, fmt.Errorf("backupupload: upload session for %q already active", name)
	}
	f, err := os.OpenFile(s.stagingPath(name), os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	ses := &Session{store: s, name: name, file: f}
	s.sessions[name] = ses
	return ses, nil
}

type interval struct{ off, end int64 }

// Session is a single in-flight upload of one object.
type Session struct {
	store *Store
	name  string
	file  *os.File

	mu        sync.Mutex
	spans     []interval // sorted, non-overlapping after merge
	committed bool
	closed    bool
}

func (s *Session) fault(op Op) error {
	if s.store.Faults == nil {
		return nil
	}
	return s.store.Faults.Err(op)
}

// WriteChunk stages data at offset off. Chunks may arrive in any
// order. If the chunk overlaps bytes already staged, the overlapping
// region must be byte-identical, otherwise ErrOverlapConflict is
// returned and nothing is written.
func (s *Session) WriteChunk(off int64, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("backupupload: session closed")
	}
	if off < 0 {
		return errors.New("backupupload: negative offset")
	}
	if len(data) == 0 {
		return nil
	}
	end := off + int64(len(data))

	// Verify overlap consistency against already-staged bytes.
	for _, sp := range s.spans {
		lo := max(off, sp.off)
		hi := min(end, sp.end)
		if lo >= hi {
			continue
		}
		existing := make([]byte, hi-lo)
		if _, err := s.file.ReadAt(existing, lo); err != nil {
			return err
		}
		if !bytes.Equal(existing, data[lo-off:hi-off]) {
			return ErrOverlapConflict
		}
	}

	if err := s.fault(OpWrite); err != nil {
		return err
	}
	if _, err := s.file.WriteAt(data, off); err != nil {
		return err
	}
	s.spans = insertSpan(s.spans, interval{off, end})
	return nil
}

// insertSpan inserts iv into the sorted, non-overlapping span list,
// merging any spans that overlap or touch it.
func insertSpan(spans []interval, iv interval) []interval {
	i := sort.Search(len(spans), func(k int) bool { return spans[k].end >= iv.off })
	j := sort.Search(len(spans), func(k int) bool { return spans[k].off > iv.end })
	merged := iv
	for k := i; k < j; k++ {
		if spans[k].off < merged.off {
			merged.off = spans[k].off
		}
		if spans[k].end > merged.end {
			merged.end = spans[k].end
		}
	}
	out := make([]interval, 0, len(spans)-(j-i)+1)
	out = append(out, spans[:i]...)
	out = append(out, merged)
	return append(out, spans[j:]...)
}

// Commit validates the staged upload and publishes it atomically.
//
// The commit succeeds only if the staged chunks cover [0, size)
// completely, the SHA-256 of the staged content equals sum, and the
// staging file has been synced to stable storage. Publication is a
// single atomic rename followed by a directory sync, so readers see
// either the complete old version or the complete new version. On any
// failure the previously published version is left untouched.
func (s *Session) Commit(size int64, sum [sha256.Size]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("backupupload: session closed")
	}

	// 1. Validate coverage of [0, size).
	covered := int64(0)
	for _, sp := range s.spans {
		if sp.off > covered {
			break
		}
		if sp.end > covered {
			covered = sp.end
		}
	}
	if covered < size {
		return fmt.Errorf("%w: covered %d of %d bytes", ErrIncomplete, covered, size)
	}

	// 2. Validate content hash.
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(s.file, 0, size)); err != nil {
		return err
	}
	var got [sha256.Size]byte
	copy(got[:], h.Sum(nil))
	if got != sum {
		return ErrHashMismatch
	}

	// 3. Sync staged data to stable storage before publishing.
	if err := s.fault(OpSync); err != nil {
		return err
	}
	if err := s.file.Sync(); err != nil {
		return err
	}
	if err := s.file.Close(); err != nil {
		return err
	}

	// 4. Publish atomically. rename(2) replaces the old version in a
	// single atomic step; readers holding the old file keep reading it.
	if err := s.fault(OpRename); err != nil {
		return err
	}
	if err := os.Rename(s.store.stagingPath(s.name), s.store.finalPath(s.name)); err != nil {
		return err
	}
	if err := syncDir(s.store.dir); err != nil {
		return err
	}

	s.committed = true
	s.closeLocked()
	return nil
}

// Abort discards the staged upload.
func (s *Session) Abort() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.file.Close()
	s.closeLocked()
	return os.Remove(s.store.stagingPath(s.name))
}

func (s *Session) closeLocked() {
	s.closed = true
	s.store.mu.Lock()
	delete(s.store.sessions, s.name)
	s.store.mu.Unlock()
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
