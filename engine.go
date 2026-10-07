// Package indexrebuild implements online index rebuilding: freeze the source
// version, bulk-build a new index from the frozen snapshot, replay the
// incremental commits (including deletes) that landed during the build, then
// atomically switch under a write barrier. Queries always read the active
// index, so they keep using the old index until the switch.
package indexrebuild

import "sync"

// Op is the kind of a committed mutation.
type Op uint8

const (
	OpPut Op = iota
	OpDelete
)

// Delta is one committed mutation recorded in the incremental log.
type Delta struct {
	Version uint64
	Op      Op
	Key     string
	Value   string
}

// Index is an immutable-from-outside mirror of the main table, consistent up
// to a source version.
type Index struct {
	data    map[string]string
	version uint64
}

// Version returns the source version the index is consistent with.
func (idx *Index) Version() uint64 { return idx.version }

func (idx *Index) get(key string) (string, bool) {
	v, ok := idx.data[key]
	return v, ok
}

// apply folds a delta into the index. It is idempotent: deltas at or below
// the index version are skipped, so replay may overlap freely.
func (idx *Index) apply(d Delta) {
	if d.Version <= idx.version {
		return
	}
	switch d.Op {
	case OpPut:
		idx.data[d.Key] = d.Value
	case OpDelete:
		delete(idx.data, d.Key)
	}
	idx.version = d.Version
}

// Engine is the main table plus the index currently serving queries.
type Engine struct {
	mu      sync.RWMutex
	data    map[string]string
	version uint64
	// deltas is the incremental commit log used to catch a rebuilt index up
	// with commits that landed after the frozen version. It is append-only;
	// production systems would truncate it once no rebuild needs it.
	deltas []Delta
	active *Index
}

func NewEngine() *Engine {
	return &Engine{
		data:   make(map[string]string),
		active: &Index{data: make(map[string]string)},
	}
}

// Put commits an upsert to the main table and the active index.
func (e *Engine) Put(key, value string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.commitLocked(Delta{Op: OpPut, Key: key, Value: value})
}

// Delete commits a removal to the main table and the active index.
func (e *Engine) Delete(key string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.commitLocked(Delta{Op: OpDelete, Key: key})
}

// commitLocked is the single commit path: bump the version, mutate the main
// table, append to the incremental log, and keep the serving index current.
// Holding the write lock across all four steps is what makes the rebuild
// barrier (see Rebuild) race-free.
func (e *Engine) commitLocked(d Delta) {
	e.version++
	d.Version = e.version
	if d.Op == OpPut {
		e.data[d.Key] = d.Value
	} else {
		delete(e.data, d.Key)
	}
	e.deltas = append(e.deltas, d)
	e.active.apply(d)
}

// Get serves a query from the active index only. Before the atomic switch
// this is the old index; afterwards it is the rebuilt one.
func (e *Engine) Get(key string) (string, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.active.get(key)
}

// FullScan returns a consistent copy of the main table: the ground truth a
// rebuilt index is checked against.
func (e *Engine) FullScan() map[string]string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make(map[string]string, len(e.data))
	for k, v := range e.data {
		out[k] = v
	}
	return out
}

// ActiveMatchesMainTable reports whether the serving index is an exact
// mirror of the main table, compared atomically under the read lock.
func (e *Engine) ActiveMatchesMainTable() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if len(e.active.data) != len(e.data) {
		return false
	}
	for k, v := range e.data {
		got, ok := e.active.data[k]
		if !ok || got != v {
			return false
		}
	}
	return true
}
