package logcompact

import "errors"

// ErrRegistryFull is returned by Acquire when no reader slot is free.
var ErrRegistryFull = errors.New("reader registry full")

// ErrStaleHandle is returned by Release when the handle's generation does not
// match the slot's current generation, i.e. the handle is stale (its slot was
// released and possibly re-acquired by another reader).
var ErrStaleHandle = errors.New("stale reader handle: generation mismatch")

// Handle pins a reader snapshot. It is only valid for the generation in which
// it was acquired; after Release the same slot may be handed out again with a
// bumped generation, and the old Handle becomes stale.
type Handle struct {
	slot       int
	generation uint64
	snapshot   uint64
}

// Snapshot returns the snapshot version pinned by this handle.
func (h Handle) Snapshot() uint64 { return h.snapshot }

type slot struct {
	generation uint64
	snapshot   uint64
	active     bool
}

// Registry tracks active snapshot readers over a fixed set of slots. Each
// slot carries a generation counter so that a stale Release (ABA: slot freed
// and reused) cannot drop a newer reader's pin.
type Registry struct {
	slots []slot
}

// NewRegistry creates a registry with the given number of reader slots.
func NewRegistry(size int) *Registry {
	return &Registry{slots: make([]slot, size)}
}

// Acquire pins a snapshot version and returns its handle.
func (r *Registry) Acquire(snapshot uint64) (Handle, error) {
	for i := range r.slots {
		if !r.slots[i].active {
			r.slots[i].active = true
			r.slots[i].generation++
			r.slots[i].snapshot = snapshot
			return Handle{slot: i, generation: r.slots[i].generation, snapshot: snapshot}, nil
		}
	}
	return Handle{}, ErrRegistryFull
}

// Release drops the pin. It returns ErrStaleHandle if the handle's generation
// no longer matches the slot, protecting a reused slot from a stale release.
func (r *Registry) Release(h Handle) error {
	if h.slot < 0 || h.slot >= len(r.slots) {
		return ErrStaleHandle
	}
	s := &r.slots[h.slot]
	if !s.active || s.generation != h.generation {
		return ErrStaleHandle
	}
	s.active = false
	return nil
}

// Snapshots returns the snapshot versions pinned by all active readers.
func (r *Registry) Snapshots() []uint64 {
	var out []uint64
	for _, s := range r.slots {
		if s.active {
			out = append(out, s.snapshot)
		}
	}
	return out
}
