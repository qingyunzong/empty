package boolcov

import "sync/atomic"

// Table is a coverage table frozen to one source version. The version is
// the whole-tree structure hash of the AST it was created from; the set of
// counted node IDs never changes afterwards. Counters are safe for
// concurrent use by any number of evaluating goroutines.
type Table struct {
	version uint64
	counts  map[string]*atomic.Uint64
	own     map[string]uint64 // node ID -> own structure hash, for migration
}

// Freeze creates a zeroed coverage table for the given AST. The table is
// bound to the tree's structure hash as its source version.
func Freeze(root *Node) *Table {
	t := &Table{
		version: treeHash(root),
		counts:  make(map[string]*atomic.Uint64),
		own:     make(map[string]uint64),
	}
	walk(root, func(n *Node) {
		if _, ok := t.counts[n.ID]; !ok {
			t.counts[n.ID] = new(atomic.Uint64)
			t.own[n.ID] = ownHash(n)
		}
	})
	return t
}

// Version returns the source version (whole-tree structure hash) this
// table is frozen to.
func (t *Table) Version() uint64 { return t.version }

// Count returns the recorded count for a node ID, or 0 for unknown IDs.
func (t *Table) Count(id string) uint64 {
	if c, ok := t.counts[id]; ok {
		return c.Load()
	}
	return 0
}

// Snapshot returns a consistent copy of all counts keyed by node ID.
func (t *Table) Snapshot() map[string]uint64 {
	out := make(map[string]uint64, len(t.counts))
	for id, c := range t.counts {
		out[id] = c.Load()
	}
	return out
}

// add increments the counter for id. Unknown IDs (evaluating an AST that
// does not match the frozen version) are ignored rather than corrupting
// the frozen schema.
func (t *Table) add(id string) {
	if c, ok := t.counts[id]; ok {
		c.Add(1)
	}
}

// Migrate produces a new table frozen to newRoot's source version. Counts
// carry over for nodes whose stable ID survives the rewrite AND whose own
// structure is unchanged; any node whose structure changed (or that is
// new) starts at zero. The old table is left untouched.
func (t *Table) Migrate(newRoot *Node) *Table {
	next := Freeze(newRoot)
	walk(newRoot, func(n *Node) {
		if oldOwn, ok := t.own[n.ID]; ok && oldOwn == ownHash(n) {
			next.counts[n.ID].Store(t.Count(n.ID))
		}
	})
	return next
}

// Merge adds all counts from other into t. Both tables must be frozen to
// the same version; Merge panics otherwise. Useful for combining shards
// from multiple executors.
func (t *Table) Merge(other *Table) {
	if t.version != other.version {
		panic("boolcov: cannot merge tables of different versions")
	}
	for id, c := range other.counts {
		if dst, ok := t.counts[id]; ok {
			dst.Add(c.Load())
		}
	}
}

// shard returns an independent table with the same frozen schema, for
// executors that prefer to aggregate later via Merge.
func (t *Table) shard() *Table {
	s := &Table{version: t.version, counts: make(map[string]*atomic.Uint64, len(t.counts)), own: t.own}
	for id := range t.counts {
		s.counts[id] = new(atomic.Uint64)
	}
	return s
}
