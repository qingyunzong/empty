package formal

import (
	"fmt"
	"sort"
	"sync"
)

// Version is one committed version of a key.
type Version struct {
	Key string
	TS  uint64
	Val []byte

	size int
}

// Size returns the accounted byte size of the version.
func (v *Version) Size() int { return v.size }

// Txn is an active transaction holding a snapshot of the store.
//
// A Txn is not safe for concurrent use by multiple goroutines; the
// Engine itself is.
type Txn struct {
	id   uint64
	snap uint64
	eng  *Engine

	done    bool
	pending []pendingWrite
}

type pendingWrite struct {
	key string
	val []byte
}

// SnapshotTS returns the snapshot timestamp of the transaction.
func (t *Txn) SnapshotTS() uint64 { return t.snap }

// Write buffers a key/value pair to be committed with the transaction.
// A transaction must not write the same key twice.
func (t *Txn) Write(key, val string) {
	if t.done {
		panic("formal: write on finished transaction")
	}
	t.pending = append(t.pending, pendingWrite{key: key, val: []byte(val)})
}

// Commit assigns a commit timestamp, publishes all buffered writes as
// new versions and releases the transaction snapshot.
func (t *Txn) Commit() uint64 {
	e := t.eng
	e.mu.Lock()
	defer e.mu.Unlock()
	if t.done {
		panic("formal: commit of finished transaction")
	}
	t.done = true
	e.clock++
	ts := e.clock
	for _, w := range t.pending {
		v := &Version{Key: w.key, TS: ts, Val: w.val, size: len(w.key) + len(w.val)}
		e.chains[w.key] = append(e.chains[w.key], v)
		e.totalBytes += uint64(v.size)
		e.totalCount++
	}
	t.pending = nil
	e.closeLocked(t)
	return ts
}

// Rollback releases the transaction snapshot without publishing writes.
func (t *Txn) Rollback() {
	e := t.eng
	e.mu.Lock()
	defer e.mu.Unlock()
	if t.done {
		panic("formal: rollback of finished transaction")
	}
	t.done = true
	t.pending = nil
	e.closeLocked(t)
}

// Get resolves the version of key visible to the transaction snapshot.
func (t *Txn) Get(key string) (*Version, bool) {
	e := t.eng
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.visibleLocked(key, t.snap)
}

// Scan resolves the visible version of every key in [lo, hi). An empty
// hi means no upper bound.
func (t *Txn) Scan(lo, hi string) []Version {
	e := t.eng
	e.mu.Lock()
	defer e.mu.Unlock()
	keys := make([]string, 0, len(e.chains))
	for k := range e.chains {
		if k >= lo && (hi == "" || k < hi) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var out []Version
	for _, k := range keys {
		if v, ok := e.visibleLocked(k, t.snap); ok {
			out = append(out, *v)
		}
	}
	return out
}

// GCStats reports what a single GC pass reclaimed.
type GCStats struct {
	SafeTS   uint64
	Versions int
	Bytes    uint64
}

// Stats is a consistent snapshot of the engine accounting.
type Stats struct {
	Clock             uint64
	SafeTS            uint64
	Active            int
	TotalVersions     uint64
	TotalBytes        uint64
	ReclaimedVersions uint64
	ReclaimedBytes    uint64
	LiveVersions      uint64
	LiveBytes         uint64
}

// Engine tracks version chains, active snapshots and the safe GC
// watermark. The safe watermark is the minimum snapshot timestamp among
// active transactions (or the commit clock when none are active); it
// advances monotonically and GC evaluates every version against it in
// commit order, so no reclaimable version is ever skipped.
type Engine struct {
	mu      sync.Mutex
	clock   uint64
	nextID  uint64
	active  map[uint64]*Txn
	snapRef map[uint64]int
	safe    uint64

	chains map[string][]*Version // per key, ascending commit TS

	totalBytes     uint64
	totalCount     uint64
	reclaimedBytes uint64
	reclaimedCount uint64
}

// NewEngine returns an empty Engine.
func NewEngine() *Engine {
	return &Engine{
		active:  map[uint64]*Txn{},
		snapRef: map[uint64]int{},
		chains:  map[string][]*Version{},
	}
}

// Begin starts a transaction at the current commit clock.
func (e *Engine) Begin() *Txn {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.nextID++
	t := &Txn{id: e.nextID, snap: e.clock, eng: e}
	e.active[t.id] = t
	e.snapRef[t.snap]++
	return t
}

// SafeTS returns the current safe watermark.
func (e *Engine) SafeTS() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.safe
}

// Stats returns a consistent snapshot of the engine accounting.
func (e *Engine) Stats() Stats {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.statsLocked()
}

func (e *Engine) statsLocked() Stats {
	return Stats{
		Clock:             e.clock,
		SafeTS:            e.safe,
		Active:            len(e.active),
		TotalVersions:     e.totalCount,
		TotalBytes:        e.totalBytes,
		ReclaimedVersions: e.reclaimedCount,
		ReclaimedBytes:    e.reclaimedBytes,
		LiveVersions:      e.totalCount - e.reclaimedCount,
		LiveBytes:         e.totalBytes - e.reclaimedBytes,
	}
}

// ActiveSnapshots returns the sorted snapshot timestamps of all active
// transactions (deduplicated).
func (e *Engine) ActiveSnapshots() []uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]uint64, 0, len(e.snapRef))
	for s := range e.snapRef {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// DumpChains returns the commit timestamps still present in every
// version chain, in ascending order.
func (e *Engine) DumpChains() map[string][]uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string][]uint64, len(e.chains))
	for k, c := range e.chains {
		tss := make([]uint64, len(c))
		for i, v := range c {
			tss[i] = v.TS
		}
		out[k] = tss
	}
	return out
}

// GC reclaims every version that no active or future snapshot can see.
//
// The pass is double-checked: the safe watermark is computed first, then
// re-validated under the lock, and every victim is re-checked against
// the raw active snapshot set before it is unlinked. A version is
// reclaimable iff its chain successor is at or below the safe watermark.
func (e *Engine) GC() GCStats {
	// Phase 1: advance and read the safe watermark.
	e.mu.Lock()
	e.advanceLocked()
	e.mu.Unlock()

	// Phase 2: re-lock, recompute, and double-check every victim
	// against the current active set before unlinking it.
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advanceLocked()
	safe := e.safe
	stats := GCStats{SafeTS: safe}
	for key, c := range e.chains {
		cut := sort.Search(len(c), func(i int) bool { return c[i].TS > safe })
		if cut == 0 {
			continue
		}
		victims := c[:cut-1]
		for j := range victims {
			if e.visibleToAnyLocked(c, j) {
				panic(fmt.Sprintf("formal: refusing to reclaim version %s@%d visible to an active snapshot", key, c[j].TS))
			}
			stats.Bytes += uint64(c[j].size)
		}
		if len(victims) > 0 {
			rest := make([]*Version, len(c)-len(victims))
			copy(rest, c[len(victims):])
			e.chains[key] = rest
			stats.Versions += len(victims)
		}
	}
	e.reclaimedBytes += stats.Bytes
	e.reclaimedCount += uint64(stats.Versions)
	return stats
}

func (e *Engine) closeLocked(t *Txn) {
	delete(e.active, t.id)
	if e.snapRef[t.snap]--; e.snapRef[t.snap] == 0 {
		delete(e.snapRef, t.snap)
	}
	e.advanceLocked()
}

// advanceLocked moves the safe watermark forward. It never regresses:
// snapshots are handed out from a monotone clock, so the minimum active
// snapshot is non-decreasing over time.
func (e *Engine) advanceLocked() {
	s := e.clock
	for snap := range e.snapRef {
		if snap < s {
			s = snap
		}
	}
	if s > e.safe {
		e.safe = s
	}
}

// visibleLocked resolves the newest version of key with TS <= snap.
func (e *Engine) visibleLocked(key string, snap uint64) (*Version, bool) {
	c := e.chains[key]
	i := sort.Search(len(c), func(i int) bool { return c[i].TS > snap }) - 1
	if i < 0 {
		return nil, false
	}
	return c[i], true
}

// visibleToAnyLocked is the naive brute-force check: version c[j] is
// visible to a snapshot s iff c[j].TS <= s < successorTS. It is checked
// against every active snapshot plus the commit clock (which stands in
// for all future snapshots).
func (e *Engine) visibleToAnyLocked(c []*Version, j int) bool {
	v := c[j]
	next := ^uint64(0)
	if j+1 < len(c) {
		next = c[j+1].TS
	}
	visible := func(s uint64) bool { return v.TS <= s && s < next }
	if visible(e.clock) {
		return true
	}
	for s := range e.snapRef {
		if visible(s) {
			return true
		}
	}
	return false
}
