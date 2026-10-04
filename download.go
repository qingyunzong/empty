package leasequota

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// Store manages downloads into a directory, accounting every byte against a
// Quota. It is safe for concurrent use.
type Store struct {
	dir   string
	quota *Quota

	mu    sync.Mutex
	files map[string]int64 // committed file name -> size in bytes
}

// NewStore returns a Store writing into dir (created if needed) and
// accounting against quota.
func NewStore(dir string, quota *Quota) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("leasequota: creating store dir: %w", err)
	}
	return &Store{dir: dir, quota: quota, files: make(map[string]int64)}, nil
}

// Quota returns the quota the store accounts against.
func (s *Store) Quota() *Quota { return s.quota }

// Size reports the committed size of name.
func (s *Store) Size(name string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	size, ok := s.files[name]
	return size, ok
}

// Files returns the sorted names of all committed files.
func (s *Store) Files() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(s.files))
	for name := range s.files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Delete removes a committed file and frees its used quota.
func (s *Store) Delete(name string) error {
	s.mu.Lock()
	size, ok := s.files[name]
	if ok {
		delete(s.files, name)
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("leasequota: delete %q: %w", name, os.ErrNotExist)
	}
	if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.mu.Lock()
		s.files[name] = size
		s.mu.Unlock()
		return fmt.Errorf("leasequota: removing %q: %w", name, err)
	}
	return s.quota.Free(size)
}

// Hooks inject faults into a download; the zero value means no faults.
type Hooks struct {
	// BeforeCommit runs after the temp file is fully written and fsynced but
	// before it is renamed into place. A non-nil error aborts the commit: the
	// temp file is removed and the full reservation is returned to the quota.
	BeforeCommit func(name string) error
}

// Download is one in-flight download holding a quota lease.
type Download struct {
	store *Store
	name  string
	lease *Lease
	hooks Hooks

	mu      sync.Mutex
	tmp     *os.File
	tmpPath string
	written int64
	done    bool
}

// Start reserves expectedLen bytes of quota and opens a temp file for name.
// The declared length may later prove wrong: Write grows the lease on demand
// if the source delivers more, and Commit returns whatever reservation was
// not actually written. An optional Hooks argument injects faults (tests).
func (s *Store) Start(name string, expectedLen int64, hooks ...*Hooks) (*Download, error) {
	if filepath.Base(name) != name {
		return nil, fmt.Errorf("leasequota: invalid file name %q", name)
	}
	lease, err := s.quota.Reserve(expectedLen)
	if err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(s.dir, ".tmp-"+name+"-*")
	if err != nil {
		lease.Release()
		return nil, fmt.Errorf("leasequota: creating temp file: %w", err)
	}
	d := &Download{store: s, name: name, lease: lease, tmp: tmp, tmpPath: tmp.Name()}
	if len(hooks) > 0 && hooks[0] != nil {
		d.hooks = *hooks[0]
	}
	return d, nil
}

// Written reports how many bytes have been written so far.
func (d *Download) Written() int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.written
}

// Write appends p to the temp file. If p exceeds the outstanding reservation
// (the source is delivering more than its declared length) the lease is
// grown on demand; if the quota cannot cover the growth the write fails and
// the download should be cancelled.
func (d *Download) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.done {
		return 0, errors.New("leasequota: download already finished")
	}
	if need := int64(len(p)) - d.lease.Outstanding(); need > 0 {
		if err := d.lease.Grow(need); err != nil {
			return 0, fmt.Errorf("leasequota: source length grew past reservation: %w", err)
		}
	}
	n, err := d.tmp.Write(p)
	d.written += int64(n)
	if err != nil {
		return n, fmt.Errorf("leasequota: writing temp file: %w", err)
	}
	return n, nil
}

// Commit fsyncs the temp file, atomically renames it to its final name and
// converts exactly the bytes actually written into used quota. Reserved but
// unwritten bytes (a short write) are returned to the quota. If the commit
// fails at any point, the temp file is removed and the full reservation is
// returned instead. After Commit the download is finished and its quota can
// no longer be cancelled.
func (d *Download) Commit() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.done {
		return errors.New("leasequota: download already finished")
	}
	d.done = true

	if err := d.tmp.Sync(); err != nil {
		return d.abort(fmt.Errorf("leasequota: syncing temp file: %w", err))
	}
	if d.hooks.BeforeCommit != nil {
		if err := d.hooks.BeforeCommit(d.name); err != nil {
			return d.abort(fmt.Errorf("leasequota: commit aborted: %w", err))
		}
	}
	if err := d.tmp.Close(); err != nil {
		os.Remove(d.tmpPath)
		d.lease.Release()
		return fmt.Errorf("leasequota: closing temp file: %w", err)
	}
	finalPath := filepath.Join(d.store.dir, d.name)
	if err := os.Rename(d.tmpPath, finalPath); err != nil {
		os.Remove(d.tmpPath)
		d.lease.Release()
		return fmt.Errorf("leasequota: renaming into place: %w", err)
	}
	if err := d.lease.Commit(d.written); err != nil {
		// Unreachable: written never exceeds the reservation.
		os.Remove(finalPath)
		return err
	}
	d.store.mu.Lock()
	d.store.files[d.name] = d.written
	d.store.mu.Unlock()
	return nil
}

// abort cleans up a failed commit whose temp file is still open: close and
// remove the temp file and return the full reservation.
func (d *Download) abort(err error) error {
	d.tmp.Close()
	os.Remove(d.tmpPath)
	d.lease.Release()
	return err
}

// Cancel aborts the download: the temp file is removed and the entire
// reservation is returned to the quota. Cancelling after Commit is an error
// and leaves the quota untouched.
func (d *Download) Cancel() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.done {
		return errors.New("leasequota: download already finished; committed quota cannot be cancelled")
	}
	d.done = true
	d.tmp.Close()
	os.Remove(d.tmpPath)
	return d.lease.Release()
}
