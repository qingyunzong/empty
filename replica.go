package router

import "sync"

// Replica is the router's view of a single replica.
type Replica interface {
	ID() string
	// AppliedSeq reports the highest sequence number the replica has
	// applied. It may move backwards if the replica's log is revoked.
	AppliedSeq() uint64
	// Read returns the value for key and the sequence number at which
	// that value was written, so callers can prove which version they
	// received.
	Read(key string) (value string, version uint64, ok bool)
}

// LogReplica is a Replica backed by an in-memory versioned log.
type LogReplica struct {
	mu      sync.Mutex
	id      string
	applied uint64
	// history[key] holds versions in ascending sequence order.
	history map[string][]versionedValue
}

type versionedValue struct {
	seq   uint64
	value string
}

func NewLogReplica(id string) *LogReplica {
	return &LogReplica{id: id, history: make(map[string][]versionedValue)}
}

func (r *LogReplica) ID() string { return r.id }

func (r *LogReplica) AppliedSeq() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.applied
}

// Apply records value for key at seq and advances the applied sequence.
func (r *LogReplica) Apply(seq uint64, key, value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.history[key] = append(r.history[key], versionedValue{seq: seq, value: value})
	if seq > r.applied {
		r.applied = seq
	}
}

// AdvanceTo moves the applied sequence forward without writing a value
// (e.g. no-op entries or entries for other keys).
func (r *LogReplica) AdvanceTo(seq uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seq > r.applied {
		r.applied = seq
	}
}

// Revoke truncates the log: every entry with sequence > seq is dropped
// and the applied sequence rolls back to seq.
func (r *LogReplica) Revoke(seq uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seq >= r.applied {
		return
	}
	r.applied = seq
	for key, versions := range r.history {
		kept := versions[:0]
		for _, v := range versions {
			if v.seq <= seq {
				kept = append(kept, v)
			}
		}
		r.history[key] = kept
	}
}

// Read returns the newest value written at or below the applied
// sequence, along with the sequence it was written at.
func (r *LogReplica) Read(key string) (string, uint64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	versions := r.history[key]
	for i := len(versions) - 1; i >= 0; i-- {
		if versions[i].seq <= r.applied {
			return versions[i].value, versions[i].seq, true
		}
	}
	return "", 0, false
}
