// Package backupstore implements the receiver side of a backup upload
// library. Fragments may arrive out of order and may overlap; overlapping
// bytes must be identical. A commit is published atomically (rename) only
// after every fragment has been validated and fsynced, so readers either
// see the complete old version or the complete new version.
package backupstore

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	ErrNotFound   = errors.New("backupstore: object not found")
	ErrIncomplete = errors.New("backupstore: fragments do not cover the declared size")
	ErrConflict   = errors.New("backupstore: overlapping fragment bytes differ")
	ErrInvalidKey = errors.New("backupstore: invalid object key")
	ErrCommitted  = errors.New("backupstore: upload already committed")
	ErrAborted    = errors.New("backupstore: upload already aborted")
)

// Store manages committed objects and in-progress uploads under dir.
type Store struct {
	fs  FS
	dir string
}

// Open (re)opens a store rooted at dir, recovering from any previous crash:
// staging files that were never committed are discarded, so every committed
// object is either the complete old version or the complete new version.
func Open(fs FS, dir string) (*Store, error) {
	if fs == nil {
		fs = osFS{}
	}
	if err := fs.MkdirAll(filepath.Join(dir, "objects"), 0o755); err != nil {
		return nil, err
	}
	staging := filepath.Join(dir, "staging")
	if err := fs.MkdirAll(staging, 0o755); err != nil {
		return nil, err
	}
	entries, err := fs.ReadDir(staging)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if err := fs.Remove(filepath.Join(staging, e.Name())); err != nil {
			return nil, err
		}
	}
	return &Store{fs: fs, dir: dir}, nil
}

func validateKey(key string) error {
	if key == "" || key == "." || key == ".." ||
		strings.ContainsAny(key, "/\\\x00") {
		return ErrInvalidKey
	}
	return nil
}

// Get opens the currently committed version of key for reading. A reader
// that opened the object before a commit keeps reading the old version,
// because commits publish via atomic rename.
func (s *Store) Get(key string) (io.ReadCloser, error) {
	if err := validateKey(key); err != nil {
		return nil, err
	}
	f, err := s.fs.Open(filepath.Join(s.dir, "objects", key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

type interval struct {
	start, end int64
}

// Upload is a single in-progress upload for one key.
type Upload struct {
	store   *Store
	key     string
	size    int64
	staging string
	final   string

	mu        sync.Mutex
	f         File
	intervals []interval // sorted, non-overlapping, merged
	synced    bool
	renamed   bool
	done      bool
	aborted   bool
}

// BeginUpload starts an upload that must total size bytes before commit.
func (s *Store) BeginUpload(key string, size int64) (*Upload, error) {
	if err := validateKey(key); err != nil {
		return nil, err
	}
	if size < 0 {
		return nil, fmt.Errorf("backupstore: negative size %d", size)
	}
	staging := filepath.Join(s.dir, "staging", key+".tmp")
	f, err := s.fs.OpenFile(staging, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	return &Upload{
		store:   s,
		key:     key,
		size:    size,
		staging: staging,
		final:   filepath.Join(s.dir, "objects", key),
		f:       f,
	}, nil
}

// WriteFragment writes data at off. Fragments may arrive in any order and
// may overlap previously written fragments, but overlapping bytes must be
// identical or ErrConflict is returned and the fragment is rejected.
// A failed write (e.g. injected IO error) records nothing and may be retried.
func (u *Upload) WriteFragment(off int64, data []byte) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return ErrCommitted
	}
	if u.aborted {
		return ErrAborted
	}
	end := off + int64(len(data))
	if off < 0 || end > u.size {
		return fmt.Errorf("backupstore: fragment [%d,%d) out of range [0,%d)", off, end, u.size)
	}
	if len(data) == 0 {
		return nil
	}
	for _, iv := range u.intervals {
		lo, hi := max(off, iv.start), min(end, iv.end)
		if lo >= hi {
			continue
		}
		prev := make([]byte, hi-lo)
		if _, err := u.f.ReadAt(prev, lo); err != nil {
			return err
		}
		if !bytes.Equal(prev, data[lo-off:hi-off]) {
			return ErrConflict
		}
	}
	if _, err := u.f.WriteAt(data, off); err != nil {
		return err
	}
	u.intervals = merge(u.intervals, interval{off, end})
	u.synced = false
	return nil
}

// Commit validates full coverage, fsyncs the staged bytes, then publishes
// them with an atomic rename followed by directory fsyncs. It is safe to
// retry Commit after an error: completed steps are not repeated.
func (u *Upload) Commit() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return ErrCommitted
	}
	if u.aborted {
		return ErrAborted
	}
	covered := len(u.intervals) == 1 && u.intervals[0].start == 0 && u.intervals[0].end == u.size
	if u.size == 0 && len(u.intervals) == 0 {
		covered = true
	}
	if !covered {
		return ErrIncomplete
	}
	if !u.renamed {
		if !u.synced {
			if err := u.f.Sync(); err != nil {
				return err
			}
			u.synced = true
		}
		if u.f != nil {
			if err := u.f.Close(); err != nil {
				return err
			}
			u.f = nil
		}
		if err := u.store.fs.Rename(u.staging, u.final); err != nil {
			// A retried commit may find a previous attempt already renamed.
			if exists(u.store.fs, u.staging) || !exists(u.store.fs, u.final) {
				return err
			}
		}
		u.renamed = true
	}
	if err := u.store.fs.SyncDir(filepath.Dir(u.final)); err != nil {
		return err
	}
	if err := u.store.fs.SyncDir(filepath.Dir(u.staging)); err != nil {
		return err
	}
	u.done = true
	return nil
}

// Abort discards the staged upload.
func (u *Upload) Abort() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return ErrCommitted
	}
	if u.aborted {
		return nil
	}
	u.aborted = true
	if u.f != nil {
		u.f.Close()
		u.f = nil
	}
	return u.store.fs.Remove(u.staging)
}

func exists(fs FS, path string) bool {
	f, err := fs.Open(path)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

func merge(intervals []interval, iv interval) []interval {
	var out []interval
	for _, cur := range intervals {
		switch {
		case cur.end < iv.start:
			out = append(out, cur)
		case iv.end < cur.start:
			out = append(out, iv)
			iv = cur
		default:
			iv = interval{min(iv.start, cur.start), max(iv.end, cur.end)}
		}
	}
	return append(out, iv)
}
