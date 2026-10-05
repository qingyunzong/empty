// Package dirdiff computes dependency-ordered operation plans that transform
// one directory manifest into another. Entries are matched by stable IDs, so
// renames and moves are reported as moves rather than delete+create pairs.
package dirdiff

import (
	"fmt"
	"hash/fnv"
	"sort"
)

// Entry is a single node of a directory tree. ID is a stable identity that
// survives renames; Path is the slash-separated location of the entry.
type Entry struct {
	ID   string
	Path string
}

// Manifest is an immutable snapshot of a directory tree: a set of entries
// with unique IDs and unique paths.
type Manifest struct {
	byID    map[string]string // ID -> path
	byPath  map[string]string // path -> ID
	ids     []string          // sorted IDs for deterministic iteration
	version uint64
}

// NewManifest validates entries and builds a Manifest. IDs and paths must
// each be unique and non-empty.
func NewManifest(entries []Entry) (Manifest, error) {
	m := Manifest{byID: make(map[string]string), byPath: make(map[string]string)}
	for _, e := range entries {
		if e.ID == "" {
			return Manifest{}, fmt.Errorf("dirdiff: entry with empty ID")
		}
		if e.Path == "" {
			return Manifest{}, fmt.Errorf("dirdiff: entry %q has empty path", e.ID)
		}
		if _, dup := m.byID[e.ID]; dup {
			return Manifest{}, fmt.Errorf("dirdiff: duplicate ID %q", e.ID)
		}
		if _, dup := m.byPath[e.Path]; dup {
			return Manifest{}, fmt.Errorf("dirdiff: duplicate path %q", e.Path)
		}
		m.byID[e.ID] = e.Path
		m.byPath[e.Path] = e.ID
		m.ids = append(m.ids, e.ID)
	}
	sort.Strings(m.ids)
	m.version = m.computeVersion()
	return m, nil
}

// MustManifest is NewManifest that panics on error, for tests and literals.
func MustManifest(entries ...Entry) Manifest {
	m, err := NewManifest(entries)
	if err != nil {
		panic(err)
	}
	return m
}

// Version is a content hash over the sorted (ID, path) pairs. Two manifests
// with the same entries have the same version.
func (m Manifest) Version() uint64 { return m.version }

func (m Manifest) computeVersion() uint64 {
	h := fnv.New64a()
	for _, id := range m.ids {
		h.Write([]byte(id))
		h.Write([]byte{0})
		h.Write([]byte(m.byID[id]))
		h.Write([]byte{0xff})
	}
	return h.Sum64()
}

// Len returns the number of entries.
func (m Manifest) Len() int { return len(m.ids) }

// Path returns the path of the entry with the given ID.
func (m Manifest) Path(id string) (string, bool) {
	p, ok := m.byID[id]
	return p, ok
}

// Entries returns all entries sorted by ID.
func (m Manifest) Entries() []Entry {
	out := make([]Entry, 0, len(m.ids))
	for _, id := range m.ids {
		out = append(out, Entry{ID: id, Path: m.byID[id]})
	}
	return out
}

// Equal reports whether both manifests contain exactly the same ID->path
// assignments.
func (m Manifest) Equal(other Manifest) bool {
	if len(m.ids) != len(other.ids) {
		return false
	}
	for _, id := range m.ids {
		p, ok := other.byID[id]
		if !ok || p != m.byID[id] {
			return false
		}
	}
	return true
}
