// Package leasecleaner implements a staging-file cleaner driven by
// persistent leases with explicit deadlines.
//
// A staged file is reclaimed once its lease expires (now >= deadline).
// Renewal and deletion are serialized through the same critical section,
// and every lease carries a generation so that a stale (old-generation)
// cleaner can never delete a newer file re-staged under the same name.
// Lease state is persisted synchronously, so an unrecovered crash
// ("power loss") never loses a renewal.
package leasecleaner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	stateFile = "leases.json"
	stateTmp  = "leases.json.tmp"
)

var (
	ErrNotFound           = errors.New("leasecleaner: no such lease")
	ErrGenerationMismatch = errors.New("leasecleaner: stale generation")
	ErrReservedName       = errors.New("leasecleaner: reserved file name")
)

// Lease grants ownership of one staged file until Deadline.
// The file is reclaimable as soon as now >= Deadline.
type Lease struct {
	Name       string
	Deadline   time.Time
	Generation uint64
}

type diskState struct {
	NextGen uint64  `json:"next_gen"`
	Leases  []Lease `json:"leases"`
}

// Cleaner manages one staging directory.
type Cleaner struct {
	dir string
	now func() time.Time

	mu      sync.Mutex
	leases  map[string]Lease
	nextGen uint64

	// beforeRevalidate is a test hook invoked between collecting an
	// expired lease and re-validating it under the lock.
	beforeRevalidate func(name string)
}

// Open loads (or creates) the cleaner rooted at dir and performs crash
// recovery: leases whose files vanished are dropped, and files without a
// persisted lease (orphans from a crashed Stage) are removed. Files with
// valid persisted leases are never touched during recovery, even if their
// deadline has already passed; only ReapExpired reclaims those.
func Open(dir string, now func() time.Time) (*Cleaner, error) {
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	c := &Cleaner{dir: dir, now: now, leases: make(map[string]Lease), nextGen: 1}

	raw, err := os.ReadFile(filepath.Join(dir, stateFile))
	switch {
	case err == nil:
		var st diskState
		if err := json.Unmarshal(raw, &st); err != nil {
			return nil, fmt.Errorf("leasecleaner: corrupt state: %w", err)
		}
		c.nextGen = st.NextGen
		if c.nextGen == 0 {
			c.nextGen = 1
		}
		for _, l := range st.Leases {
			if _, err := os.Stat(filepath.Join(dir, l.Name)); err != nil {
				continue // file is gone; drop the dangling lease
			}
			c.leases[l.Name] = l
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := e.Name()
		if name == stateFile || name == stateTmp {
			continue
		}
		if _, ok := c.leases[name]; !ok {
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				return nil, fmt.Errorf("leasecleaner: remove orphan %q: %w", name, err)
			}
		}
	}
	return c, nil
}

// Stage writes data to dir/name and grants a lease valid until deadline,
// returning the lease generation. Re-staging an existing name replaces
// the file and starts a new generation.
func (c *Cleaner) Stage(name string, data []byte, deadline time.Time) (uint64, error) {
	if name == stateFile || name == stateTmp {
		return 0, ErrReservedName
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	path := filepath.Join(c.dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return 0, err
	}
	gen := c.nextGen
	c.nextGen++
	c.leases[name] = Lease{Name: name, Deadline: deadline, Generation: gen}
	if err := c.persistLocked(); err != nil {
		return 0, err
	}
	return gen, nil
}

// Renew extends the lease on name to deadline. It only succeeds for the
// current generation, and runs in the same critical section as reaping,
// so a renewal and a deletion can never interleave: whichever acquires
// the lock first wins decisively.
func (c *Cleaner) Renew(name string, generation uint64, deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	l, ok := c.leases[name]
	if !ok {
		return ErrNotFound
	}
	if l.Generation != generation {
		return ErrGenerationMismatch
	}
	l.Deadline = deadline
	c.leases[name] = l
	return c.persistLocked()
}

// Release deletes the staged file and its lease ahead of expiry.
func (c *Cleaner) Release(name string, generation uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	l, ok := c.leases[name]
	if !ok {
		return ErrNotFound
	}
	if l.Generation != generation {
		return ErrGenerationMismatch
	}
	if err := os.Remove(filepath.Join(c.dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	delete(c.leases, name)
	return c.persistLocked()
}

// ReapExpired deletes every staged file whose lease has expired
// (now >= deadline) and returns the number of files reclaimed.
//
// Candidates are snapshotted under the lock, then each candidate is
// re-validated under the same lock immediately before deletion: the
// lease must still exist, still carry the snapshotted generation, and
// still be expired. A file re-staged under the same name after the
// snapshot belongs to a newer generation and is therefore never
// deleted by this (old-generation) pass.
func (c *Cleaner) ReapExpired() (int, error) {
	c.mu.Lock()
	var expired []Lease
	for _, l := range c.leases {
		if !c.now().Before(l.Deadline) {
			expired = append(expired, l)
		}
	}
	c.mu.Unlock()

	removed := 0
	for _, l := range expired {
		if c.beforeRevalidate != nil {
			c.beforeRevalidate(l.Name)
		}
		c.mu.Lock()
		cur, ok := c.leases[l.Name]
		if ok && cur.Generation == l.Generation && !c.now().Before(cur.Deadline) {
			if err := os.Remove(filepath.Join(c.dir, l.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				c.mu.Unlock()
				return removed, err
			}
			delete(c.leases, l.Name)
			removed++
		}
		c.mu.Unlock()
	}
	if removed > 0 {
		c.mu.Lock()
		err := c.persistLocked()
		c.mu.Unlock()
		if err != nil {
			return removed, err
		}
	}
	return removed, nil
}

// Lease returns the current lease for name.
func (c *Cleaner) Lease(name string) (Lease, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	l, ok := c.leases[name]
	return l, ok
}

// persistLocked writes the lease table atomically (temp file + fsync +
// rename + directory fsync). Callers must hold c.mu.
func (c *Cleaner) persistLocked() error {
	st := diskState{NextGen: c.nextGen}
	for _, l := range c.leases {
		st.Leases = append(st.Leases, l)
	}
	sort.Slice(st.Leases, func(i, j int) bool { return st.Leases[i].Name < st.Leases[j].Name })
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	tmp := filepath.Join(c.dir, stateTmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(c.dir, stateFile)); err != nil {
		return err
	}
	d, err := os.Open(c.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
