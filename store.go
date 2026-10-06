// Package crashreplay models a crash-prone key-value store and verifies
// recovery invariants by enumerating every subset of unsynced writes that
// may survive a crash.
package crashreplay

import "math/rand"

// MaxEnumeratedWrites is the enumeration budget: crashes with more unsynced
// writes than this are reported as unknown instead of being enumerated.
const MaxEnumeratedWrites = 18

// Write is a single logged write operation.
type Write struct {
	Seq   int
	Key   string
	Value string
}

// Store is a key-value store with an in-memory view, a persisted (disk)
// view, and a log of writes not yet synced to disk.
type Store struct {
	mem     map[string]string
	disk    map[string]string
	pending []Write
	seq     int
	rng     *rand.Rand

	// LastPublish records the publish order and fate of the pending writes
	// during the most recent Crash, for acceptance testing.
	LastPublish []PublishRecord
}

// PublishRecord describes how one pending write was treated during a crash.
type PublishRecord struct {
	Write       Write
	PublishSlot int  // position in the (scrambled) publish order
	Persisted   bool // false if the write was dropped
}

// NewStore returns an empty store. seed drives the deliberately
// out-of-order, lossy publish behaviour of Crash.
func NewStore(seed int64) *Store {
	return &Store{
		mem:  map[string]string{},
		disk: map[string]string{},
		rng:  rand.New(rand.NewSource(seed)),
	}
}

// WriteOp applies a write to the in-memory view and logs it as unsynced.
func (s *Store) WriteOp(key, value string) {
	s.seq++
	s.pending = append(s.pending, Write{Seq: s.seq, Key: key, Value: value})
	s.mem[key] = value
}

// Sync flushes all unsynced writes to disk in program order.
func (s *Store) Sync() {
	for _, w := range s.pending {
		s.disk[w.Key] = w.Value
	}
	s.pending = nil
}

// Pending returns a copy of the currently unsynced writes.
func (s *Store) Pending() []Write {
	return append([]Write(nil), s.pending...)
}

// Disk returns a copy of the persisted state.
func (s *Store) Disk() map[string]string {
	return cloneMap(s.disk)
}

// Mem returns a copy of the in-memory state.
func (s *Store) Mem() map[string]string {
	return cloneMap(s.mem)
}

// Crash simulates power loss. Unsynced writes are published to disk in a
// deliberately scrambled order and each is independently dropped, modelling
// a disk that reorders and partially loses its write cache. The in-memory
// view is discarded; recovery starts from the persisted state. It returns
// the actual recovered state.
func (s *Store) Crash() map[string]string {
	order := s.rng.Perm(len(s.pending))
	s.LastPublish = make([]PublishRecord, len(s.pending))
	for slot, idx := range order {
		w := s.pending[idx]
		kept := s.rng.Intn(2) == 0
		s.LastPublish[idx] = PublishRecord{Write: w, PublishSlot: slot, Persisted: kept}
		if kept {
			s.disk[w.Key] = w.Value
		}
	}
	s.pending = nil
	s.mem = cloneMap(s.disk)
	return cloneMap(s.disk)
}

// Recovery is one possible post-crash persisted state together with the
// subset of unsynced writes that survived.
type Recovery struct {
	Persisted []Write
	State     map[string]string
}

// PossibleRecoveries enumerates every subset of pending applied to disk in
// program order. It returns ok=false when len(pending) exceeds the
// enumeration budget (MaxEnumeratedWrites).
//
// Enumerating subsets in program order also covers out-of-order publishes:
// applying any subset in any order yields, for each key, the value of some
// write in that subset, which equals the program-order application of the
// subset containing only those per-key winning writes.
func PossibleRecoveries(disk map[string]string, pending []Write) ([]Recovery, bool) {
	if len(pending) > MaxEnumeratedWrites {
		return nil, false
	}
	total := 1 << uint(len(pending))
	recs := make([]Recovery, 0, total)
	for mask := 0; mask < total; mask++ {
		state := cloneMap(disk)
		var kept []Write
		for i, w := range pending {
			if mask&(1<<uint(i)) != 0 {
				kept = append(kept, w)
				state[w.Key] = w.Value
			}
		}
		recs = append(recs, Recovery{Persisted: kept, State: state})
	}
	return recs, true
}

func cloneMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
