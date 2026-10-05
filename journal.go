package objstore

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Journal operation codes.
const (
	opPut     = "put"      // temp-upload lease registration
	opRoot    = "root"     // set/replace a version root
	opDelRoot = "delroot"  // delete a version root
	opGCBegin = "gc-begin" // a GC cycle started
	opDelete  = "delete"   // an evidenced deletion (write-ahead)
	opGCEnd   = "gc-end"   // the GC cycle completed
)

// entry is one journaled record. Deletes carry their Evidence so a
// crash mid-sweep leaves an auditable, replayable trail.
type entry struct {
	Op        string    `json:"op"`
	Cycle     uint64    `json:"cycle,omitempty"`
	Name      string    `json:"name,omitempty"`
	Root      ID        `json:"root,omitempty"`
	ID        ID        `json:"id,omitempty"`
	Gen       uint64    `json:"gen,omitempty"`
	Committed int64     `json:"committed,omitempty"`
	Ev        *Evidence `json:"ev,omitempty"`
}

// journal is an append-only, fsynced write-ahead log. All methods are
// called with the store mutex held (hence the Locked suffix).
type journal struct {
	path string
	f    *os.File
}

func openJournal(path string) (*journal, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &journal{path: path, f: f}, nil
}

func (j *journal) appendLocked(e entry) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := j.f.Write(append(b, '\n')); err != nil {
		return err
	}
	return j.f.Sync()
}

// compactLocked rewrites the journal to just the live state: current
// roots and unexpired temp-upload leases.
func (j *journal) compactLocked(roots map[string]ID, temps map[ID]time.Time, gen uint64) error {
	tmp, err := os.CreateTemp(filepath.Dir(j.path), ".journal-*")
	if err != nil {
		return err
	}
	w := bufio.NewWriter(tmp)
	write := func(e entry) error {
		b, err := json.Marshal(e)
		if err != nil {
			return err
		}
		_, err = w.Write(append(b, '\n'))
		return err
	}
	names := make([]string, 0, len(roots))
	for n := range roots {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := write(entry{Op: opRoot, Name: n, Root: roots[n], Gen: gen}); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return err
		}
	}
	for id, t := range temps {
		if err := write(entry{Op: opPut, ID: id, Committed: t.UnixNano()}); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return err
		}
	}
	if err := w.Flush(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	j.f.Close()
	if err := os.Rename(tmp.Name(), j.path); err != nil {
		return err
	}
	f, err := os.OpenFile(j.path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	j.f = f
	return nil
}

func (j *journal) close() {
	if j.f != nil {
		j.f.Sync()
		j.f.Close()
	}
}
