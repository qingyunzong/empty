// Package vtable implements a versioned key-value table.
//
// Each commit attaches a monotonically meaningful commit sequence number to a
// key together with either a value or a tombstone. Snapshot reads at sequence
// s observe the most recent record with sequence <= s. Re-committing the same
// (key, seq) with identical content is idempotent; committing different
// content for an already-committed (key, seq) is rejected.
//
// Readers register inside generations and pin a snapshot sequence. Compaction
// collapses history but preserves every result observable by registered
// readers. A generation whose readers have all released becomes invalid and
// is dropped, allowing the versions it pinned to be freed.
package vtable

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// ErrUnknownGeneration is returned when registering a reader in a generation
// that does not exist or has already expired.
var ErrUnknownGeneration = errors.New("vtable: unknown or expired generation")

// ConflictError reports a commit whose (key, seq) was already committed with
// different content.
type ConflictError struct {
	Key string
	Seq uint64
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("vtable: conflicting commit for key %q at seq %d", e.Key, e.Seq)
}

// record is one committed version of a key.
type record struct {
	seq       uint64
	value     []byte
	tombstone bool
}

// equalContent reports whether two records carry identical content.
func (r record) equalContent(other record) bool {
	return r.tombstone == other.tombstone && bytes.Equal(r.value, other.value)
}

// generation is a cohort of readers. Once its last reader releases, the
// generation expires and no longer pins any history.
type generation struct {
	readers map[uint64]uint64 // reader id -> pinned seq
}

// Store is a concurrency-safe versioned table.
type Store struct {
	mu sync.RWMutex

	keys map[string][]record // per key, ascending by seq

	nextGen    uint64
	nextReader uint64
	gens       map[uint64]*generation
}

// New returns an empty Store.
func New() *Store {
	return &Store{
		keys: make(map[string][]record),
		gens: make(map[uint64]*generation),
	}
}

// commit inserts rec for key, enforcing same-sequence content equality.
func (s *Store) commit(key string, rec record) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	recs := s.keys[key]
	i := sort.Search(len(recs), func(i int) bool { return recs[i].seq >= rec.seq })
	if i < len(recs) && recs[i].seq == rec.seq {
		if !recs[i].equalContent(rec) {
			return &ConflictError{Key: key, Seq: rec.seq}
		}
		return nil // idempotent re-commit
	}
	recs = append(recs, record{})
	copy(recs[i+1:], recs[i:])
	recs[i] = rec
	s.keys[key] = recs
	return nil
}

// Put commits value for key at seq.
func (s *Store) Put(key string, seq uint64, value []byte) error {
	return s.commit(key, record{seq: seq, value: bytes.Clone(value)})
}

// Delete commits a tombstone for key at seq.
func (s *Store) Delete(key string, seq uint64) error {
	return s.commit(key, record{seq: seq, tombstone: true})
}

// Get returns the value visible to a snapshot at seq: the most recent record
// for key with sequence <= seq. The boolean reports whether a live (non
// tombstone) value was found.
func (s *Store) Get(key string, seq uint64) ([]byte, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rec, ok := lookup(s.keys[key], seq)
	if !ok || rec.tombstone {
		return nil, false
	}
	return bytes.Clone(rec.value), true
}

// lookup finds the newest record with sequence <= seq.
func lookup(recs []record, seq uint64) (record, bool) {
	i := sort.Search(len(recs), func(i int) bool { return recs[i].seq > seq })
	if i == 0 {
		return record{}, false
	}
	return recs[i-1], true
}

// NewGeneration creates a reader generation and returns its id.
func (s *Store) NewGeneration() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextGen++
	s.gens[s.nextGen] = &generation{readers: make(map[uint64]uint64)}
	return s.nextGen
}

// Reader pins a snapshot sequence inside a generation. Until Release is
// called, compaction preserves every result observable at the pinned seq.
type Reader struct {
	store *Store
	gen   uint64
	id    uint64
	seq   uint64
	once  sync.Once
}

// RegisterReader pins seq inside generation gen and returns the Reader.
func (s *Store) RegisterReader(gen uint64, seq uint64) (*Reader, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.gens[gen]
	if !ok {
		return nil, ErrUnknownGeneration
	}
	s.nextReader++
	g.readers[s.nextReader] = seq
	return &Reader{store: s, gen: gen, id: s.nextReader, seq: seq}, nil
}

// Seq returns the snapshot sequence pinned by the reader.
func (r *Reader) Seq() uint64 { return r.seq }

// Get reads the key at the reader's pinned snapshot.
func (r *Reader) Get(key string) ([]byte, bool) {
	return r.store.Get(key, r.seq)
}

// Release unregisters the reader. When a generation's last reader releases,
// the generation expires and compaction may free the versions it pinned.
// Release is idempotent.
func (r *Reader) Release() {
	r.once.Do(func() {
		s := r.store
		s.mu.Lock()
		defer s.mu.Unlock()
		if g, ok := s.gens[r.gen]; ok {
			delete(g.readers, r.id)
			if len(g.readers) == 0 {
				delete(s.gens, r.gen) // generation expired
			}
		}
	})
}

// watermark returns the smallest sequence still pinned by any live reader,
// and whether any reader exists.
func (s *Store) watermark() (uint64, bool) {
	var min uint64
	found := false
	for _, g := range s.gens {
		for _, seq := range g.readers {
			if !found || seq < min {
				min = seq
				found = true
			}
		}
	}
	return min, found
}

// Compact collapses per-key history while preserving every result observable
// by registered readers. For each key it keeps all records newer than the
// oldest pinned snapshot plus the single newest record at or below it (the
// record those readers would observe). With no registered readers only the
// newest record per key survives. Generations holding no readers are invalid
// and are released: they pin nothing and are forgotten, so register readers
// before compacting.
func (s *Store) Compact() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, g := range s.gens {
		if len(g.readers) == 0 {
			delete(s.gens, id)
		}
	}
	wm, hasReaders := s.watermark()
	for key, recs := range s.keys {
		var keep []record
		if hasReaders {
			// First index with seq > wm: records before it are <= wm.
			cut := sort.Search(len(recs), func(i int) bool { return recs[i].seq > wm })
			keep = make([]record, 0, len(recs)-cut+1)
			if cut > 0 {
				keep = append(keep, recs[cut-1]) // newest record <= wm
			}
			keep = append(keep, recs[cut:]...)
		} else {
			keep = []record{recs[len(recs)-1]} // newest record only
		}
		s.keys[key] = keep
	}
}

// NumRecords reports how many versions are currently stored for key. It is
// primarily useful for tests and diagnostics.
func (s *Store) NumRecords(key string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.keys[key])
}

// LiveGenerations reports the number of generations that still have readers.
func (s *Store) LiveGenerations() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.gens)
}
