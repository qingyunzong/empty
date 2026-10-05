// Package dirdiff computes dependency-ordered operation plans that transform
// one directory manifest into another. Entries are matched by stable ID, so
// path changes are emitted as moves rather than delete+create pairs. Cyclic
// moves are broken with temporary paths that never occupy a final name.
// Inverse plans re-check the target version of every entry before applying.
package dirdiff

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// MaxEntries is the maximum number of entries a manifest may hold.
const MaxEntries = 12

// Entry is a single tracked item identified by a stable ID.
type Entry struct {
	ID      string
	Path    string
	Version int
}

// Manifest is an unordered snapshot of a directory.
type Manifest struct {
	Entries []Entry
}

// Validate checks the entry limit and uniqueness of IDs and paths.
func (m Manifest) Validate() error {
	if len(m.Entries) > MaxEntries {
		return fmt.Errorf("dirdiff: manifest has %d entries, max is %d", len(m.Entries), MaxEntries)
	}
	ids := make(map[string]bool, len(m.Entries))
	paths := make(map[string]bool, len(m.Entries))
	for _, e := range m.Entries {
		if e.ID == "" || e.Path == "" {
			return errors.New("dirdiff: entry with empty ID or Path")
		}
		if ids[e.ID] {
			return fmt.Errorf("dirdiff: duplicate ID %q", e.ID)
		}
		if paths[e.Path] {
			return fmt.Errorf("dirdiff: duplicate path %q", e.Path)
		}
		ids[e.ID] = true
		paths[e.Path] = true
	}
	return nil
}

func (m Manifest) byID() map[string]Entry {
	out := make(map[string]Entry, len(m.Entries))
	for _, e := range m.Entries {
		out[e.ID] = e
	}
	return out
}

// equalSet reports whether two manifests hold the same entries ignoring order.
func equalSet(a, b Manifest) bool {
	if len(a.Entries) != len(b.Entries) {
		return false
	}
	bb := b.byID()
	for _, e := range a.Entries {
		o, ok := bb[e.ID]
		if !ok || o != e {
			return false
		}
	}
	return true
}

// Equal reports whether two manifests hold the same entries ignoring order.
func (m Manifest) Equal(o Manifest) bool { return equalSet(m, o) }

// OpKind classifies a plan operation.
type OpKind int

const (
	OpCreate OpKind = iota
	OpDelete
	OpMove
)

func (k OpKind) String() string {
	switch k {
	case OpCreate:
		return "create"
	case OpDelete:
		return "delete"
	case OpMove:
		return "move"
	}
	return "unknown"
}

// Op is one step of a plan. Version is the entry version that must be present
// when the op is applied (0 for creates); NewVersion is the version the entry
// has afterwards (0 for deletes).
type Op struct {
	Kind       OpKind
	ID         string
	From       string // move source / delete path
	To         string // move destination / create path
	Version    int
	NewVersion int
}

func (o Op) String() string {
	switch o.Kind {
	case OpCreate:
		return fmt.Sprintf("create %s at %s (v%d)", o.ID, o.To, o.NewVersion)
	case OpDelete:
		return fmt.Sprintf("delete %s at %s (v%d)", o.ID, o.From, o.Version)
	default:
		return fmt.Sprintf("move %s %s -> %s (v%d->v%d)", o.ID, o.From, o.To, o.Version, o.NewVersion)
	}
}

type pendingMove struct {
	id         string
	from, to   string
	version    int
	newVersion int
}

// tempPath picks a scratch name that is neither currently occupied nor a
// final name of the target manifest.
func tempPath(id string, occupied, finalNames map[string]bool) string {
	base := ".dirdiff-tmp-" + id
	candidate := base
	for i := 1; occupied[candidate] || finalNames[candidate]; i++ {
		candidate = fmt.Sprintf("%s-%d", base, i)
	}
	return candidate
}

// Diff computes a dependency-ordered plan transforming old into new.
// Entries present in both manifests with changed paths become moves; entries
// only in old become deletes; entries only in new become creates. Deletes are
// emitted first (they only free paths), then moves (cycles broken via
// temporary paths disjoint from every final name), then creates.
func Diff(old, new Manifest) ([]Op, error) {
	if err := old.Validate(); err != nil {
		return nil, fmt.Errorf("dirdiff: old manifest: %w", err)
	}
	if err := new.Validate(); err != nil {
		return nil, fmt.Errorf("dirdiff: new manifest: %w", err)
	}
	oldByID := old.byID()
	newByID := new.byID()

	var deletes, creates []Op
	var moves []pendingMove
	for id, o := range oldByID {
		n, ok := newByID[id]
		if !ok {
			deletes = append(deletes, Op{Kind: OpDelete, ID: id, From: o.Path, Version: o.Version})
			continue
		}
		if o.Path != n.Path || o.Version != n.Version {
			moves = append(moves, pendingMove{id: id, from: o.Path, to: n.Path, version: o.Version, newVersion: n.Version})
		}
	}
	for id, n := range newByID {
		if _, ok := oldByID[id]; !ok {
			creates = append(creates, Op{Kind: OpCreate, ID: id, To: n.Path, NewVersion: n.Version})
		}
	}
	byID := func(ops []Op) { sort.Slice(ops, func(i, j int) bool { return ops[i].ID < ops[j].ID }) }
	byID(deletes)
	byID(creates)
	sort.Slice(moves, func(i, j int) bool { return moves[i].id < moves[j].id })

	occupied := make(map[string]bool, len(old.Entries))
	for _, e := range old.Entries {
		occupied[e.Path] = true
	}
	finalNames := make(map[string]bool, len(new.Entries))
	for _, e := range new.Entries {
		finalNames[e.Path] = true
	}

	var ops []Op
	for _, d := range deletes {
		ops = append(ops, d)
		delete(occupied, d.From)
	}
	for len(moves) > 0 {
		progress := false
		for i := 0; i < len(moves); {
			m := moves[i]
			if occupied[m.to] {
				i++
				continue
			}
			ops = append(ops, Op{Kind: OpMove, ID: m.id, From: m.from, To: m.to, Version: m.version, NewVersion: m.newVersion})
			delete(occupied, m.from)
			occupied[m.to] = true
			moves = append(moves[:i], moves[i+1:]...)
			progress = true
		}
		if !progress {
			// Cycle: park the first pending move on a scratch path that
			// occupies no final name, then retry.
			m := moves[0]
			tmp := tempPath(m.id, occupied, finalNames)
			ops = append(ops, Op{Kind: OpMove, ID: m.id, From: m.from, To: tmp, Version: m.version, NewVersion: m.version})
			delete(occupied, m.from)
			occupied[tmp] = true
			moves[0].from = tmp
		}
	}
	for _, c := range creates {
		if occupied[c.To] {
			return nil, fmt.Errorf("dirdiff: internal error: create target %q still occupied", c.To)
		}
		ops = append(ops, c)
		occupied[c.To] = true
	}
	return ops, nil
}

// Invert produces the reverse plan. Applying it undoes ops; every inverted op
// re-checks the entry version it expects to find before applying.
func Invert(ops []Op) []Op {
	out := make([]Op, 0, len(ops))
	for i := len(ops) - 1; i >= 0; i-- {
		o := ops[i]
		switch o.Kind {
		case OpCreate:
			out = append(out, Op{Kind: OpDelete, ID: o.ID, From: o.To, Version: o.NewVersion})
		case OpDelete:
			out = append(out, Op{Kind: OpCreate, ID: o.ID, To: o.From, NewVersion: o.Version})
		case OpMove:
			out = append(out, Op{Kind: OpMove, ID: o.ID, From: o.To, To: o.From, Version: o.NewVersion, NewVersion: o.Version})
		}
	}
	return out
}

// Apply executes a plan against a manifest, verifying every op's expected
// version before mutating. It returns the resulting manifest.
func Apply(m Manifest, ops []Op) (Manifest, error) {
	if err := m.Validate(); err != nil {
		return Manifest{}, err
	}
	entries := make(map[string]Entry, len(m.Entries)) // keyed by path
	ids := make(map[string]string, len(m.Entries))    // id -> path
	for _, e := range m.Entries {
		entries[e.Path] = e
		ids[e.ID] = e.Path
	}
	for i, op := range ops {
		fail := func(format string, args ...any) (Manifest, error) {
			return Manifest{}, fmt.Errorf("dirdiff: op %d (%s): %s", i, op, fmt.Sprintf(format, args...))
		}
		switch op.Kind {
		case OpCreate:
			if _, busy := entries[op.To]; busy {
				return fail("create target %q occupied", op.To)
			}
			if _, dup := ids[op.ID]; dup {
				return fail("ID %q already present", op.ID)
			}
			entries[op.To] = Entry{ID: op.ID, Path: op.To, Version: op.NewVersion}
			ids[op.ID] = op.To
		case OpDelete:
			e, ok := entries[op.From]
			if !ok || e.ID != op.ID {
				return fail("no entry %q at %q", op.ID, op.From)
			}
			if e.Version != op.Version {
				return fail("version mismatch: have v%d, want v%d", e.Version, op.Version)
			}
			delete(entries, op.From)
			delete(ids, op.ID)
		case OpMove:
			e, ok := entries[op.From]
			if !ok || e.ID != op.ID {
				return fail("no entry %q at %q", op.ID, op.From)
			}
			if e.Version != op.Version {
				return fail("version mismatch: have v%d, want v%d", e.Version, op.Version)
			}
			if _, busy := entries[op.To]; busy {
				return fail("move target %q occupied", op.To)
			}
			delete(entries, op.From)
			e.Path = op.To
			e.Version = op.NewVersion
			entries[op.To] = e
			ids[op.ID] = op.To
		}
	}
	out := Manifest{Entries: make([]Entry, 0, len(entries))}
	for _, e := range entries {
		out.Entries = append(out.Entries, e)
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		if out.Entries[i].ID != out.Entries[j].ID {
			return out.Entries[i].ID < out.Entries[j].ID
		}
		return true
	})
	return out, nil
}

// IsTempPath reports whether p looks like a scratch path generated by Diff.
func IsTempPath(p string) bool {
	base := p
	if i := strings.LastIndex(p, "/"); i >= 0 {
		base = p[i+1:]
	}
	return strings.HasPrefix(base, ".dirdiff-tmp-")
}
