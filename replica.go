package formal

import "sync"

// Replica is one local key-value shard holding per-key sibling sets. It
// applies vector-clock merge semantics on every write, so a late or stale
// revision can never overwrite a newer one; concurrent revisions coexist.
type Replica struct {
	mu sync.RWMutex

	id string
	// data holds the full surviving version set per key, tombstones included.
	data map[string][]Version
	// watermark is the most recent complete GC epoch this replica knows.
	watermark int64
	// gcBarrier is the component-wise minimum vector clock each surviving
	// tombstone had when it was garbage collected. Later writes dominated by
	// this barrier are stale revivals and are rejected.
	gcBarrier map[string]VClock
}

// NewReplica builds an empty replica for node id.
func NewReplica(id string) *Replica {
	return &Replica{
		id:        id,
		data:      make(map[string][]Version),
		gcBarrier: make(map[string]VClock),
	}
}

// ID returns the replica's node ID.
func (r *Replica) ID() string { return r.id }

// Snapshot returns the surviving versions for key (tombstones included).
func (r *Replica) Snapshot(key string) []Version {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return cloneAll(r.data[key])
}

// Apply merges incoming revisions into the key's sibling set. Any revision
// dominated by the local GC barrier is a stale revival and dropped before
// merging; MergeVersions then guarantees no ancestor can replace a newer
// revision. It returns the surviving set.
func (r *Replica) Apply(key string, incoming []Version) []Version {
	r.mu.Lock()
	defer r.mu.Unlock()

	filtered := incoming[:0:0]
	barrier := r.gcBarrier[key]
	for _, v := range incoming {
		if barrier != nil && Descends(barrier, v.Clock) {
			continue
		}
		filtered = append(filtered, v)
	}
	r.data[key] = MergeVersions(r.data[key], filtered)
	return cloneAll(r.data[key])
}

// Watermark returns this replica's current safe-watermark epoch.
func (r *Replica) Watermark() int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.watermark
}

// AdvanceWatermark raises the safe watermark; it never moves backwards.
func (r *Replica) AdvanceWatermark(epoch int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if epoch > r.watermark {
		r.watermark = epoch
	}
}

// GC collects tombstones whose deletion epoch is at or below the safe
// watermark. Before removing a tombstone its clock is folded into the key's
// GC barrier so any later stale copy of the deleted value is rejected.
// Live siblings are never removed.
func (r *Replica) GC(key string) (collected int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	versions := r.data[key]
	survivors := make([]Version, 0, len(versions))
	for _, v := range versions {
		if v.Tombstone && v.DelEpoch <= r.watermark {
			barrier := r.gcBarrier[key]
			r.gcBarrier[key] = MergeClocks(barrier, v.Clock)
			collected++
			continue
		}
		survivors = append(survivors, v)
	}
	r.data[key] = survivors
	return collected
}

// GCBarrier exposes the key's current barrier; tests use it to prove stale
// revival protection after a tombstone has been collected.
func (r *Replica) GCBarrier(key string) VClock {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.gcBarrier[key].Copy()
}

// Keys returns all keys currently carrying state, for diagnostics.
func (r *Replica) Keys() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	keys := make([]string, 0, len(r.data))
	for key := range r.data {
		keys = append(keys, key)
	}
	return keys
}
