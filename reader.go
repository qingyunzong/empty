package logcompact

import (
	"errors"
	"sync"
)

// ErrStaleRelease is returned when a reader token no longer matches the
// current generation of its registry slot (double release, or a token
// from before the slot was recycled by a newer reader).
var ErrStaleRelease = errors.New("logcompact: stale or unknown reader token")

// ReaderToken identifies one registered reader. The generation guards
// against stale releases: slot IDs are recycled, but every Acquire bumps
// the slot generation, so a token captured before recycling can never
// release the newer reader occupying the same slot.
type ReaderToken struct {
	ID         uint64
	Generation uint64
	Snapshot   uint64
}

type readerSlot struct {
	generation uint64
	snapshot   uint64
	active     bool
}

// ReaderRegistry tracks active readers and the log snapshots they pin.
// It is safe for concurrent use.
type ReaderRegistry struct {
	mu    sync.Mutex
	slots map[uint64]*readerSlot
	free  []uint64 // recycled slot IDs, LIFO
	next  uint64
}

// NewReaderRegistry returns an empty registry.
func NewReaderRegistry() *ReaderRegistry {
	return &ReaderRegistry{slots: map[uint64]*readerSlot{}, next: 1}
}

// Acquire registers a reader pinning the given snapshot LSN.
func (r *ReaderRegistry) Acquire(snapshot uint64) ReaderToken {
	r.mu.Lock()
	defer r.mu.Unlock()
	var id uint64
	if n := len(r.free); n > 0 {
		id = r.free[n-1]
		r.free = r.free[:n-1]
	} else {
		id = r.next
		r.next++
	}
	slot := r.slots[id]
	if slot == nil {
		slot = &readerSlot{}
		r.slots[id] = slot
	}
	slot.generation++
	slot.snapshot = snapshot
	slot.active = true
	return ReaderToken{ID: id, Generation: slot.generation, Snapshot: snapshot}
}

// Release unregisters a reader. It returns ErrStaleRelease if the token
// is unknown, already released, or belongs to an older generation of the
// slot; in all those cases the registry is left untouched.
func (r *ReaderRegistry) Release(tok ReaderToken) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	slot := r.slots[tok.ID]
	if slot == nil || !slot.active || slot.generation != tok.Generation {
		return ErrStaleRelease
	}
	slot.active = false
	r.free = append(r.free, tok.ID)
	return nil
}

// Snapshots returns the snapshot LSNs pinned by all active readers.
func (r *ReaderRegistry) Snapshots() []uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []uint64
	for _, slot := range r.slots {
		if slot.active {
			out = append(out, slot.snapshot)
		}
	}
	return out
}

// MinSnapshot returns the smallest snapshot pinned by any active reader.
func (r *ReaderRegistry) MinSnapshot() (uint64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var min uint64
	found := false
	for _, slot := range r.slots {
		if slot.active && (!found || slot.snapshot < min) {
			min = slot.snapshot
			found = true
		}
	}
	return min, found
}

// Active returns the number of registered readers.
func (r *ReaderRegistry) Active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, slot := range r.slots {
		if slot.active {
			n++
		}
	}
	return n
}
