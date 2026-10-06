// Package vstore implements a versioned key-value table: each key maps to a
// history of records keyed by commit sequence number, where a record is
// either a value or a tombstone. Snapshot reads return the most recent
// record not greater than the snapshot sequence. Compaction retains exactly
// the records still observable by registered readers; readers belong to a
// generation and are expired when the generation advances.
package vstore

import (
	"errors"
	"sort"
	"sync"
)

// ErrConflict is returned when a record is committed with a sequence number
// that already exists for the key but with different content.
var ErrConflict = errors.New("vstore: conflicting record for same key and sequence")

// ErrReaderClosed is returned when a reader is used after being released or
// after its generation has expired.
var ErrReaderClosed = errors.New("vstore: reader released or generation expired")

// ErrSnapshotTooOld is returned when a reader is registered below the
// compaction horizon; older history has already been reclaimed.
var ErrSnapshotTooOld = errors.New("vstore: snapshot sequence below compaction horizon")

// Record is a single committed version of a key. A tombstone record marks a
// deletion; its Value is ignored.
type Record struct {
	Seq       uint64
	Value     []byte
	Tombstone bool
}

func (r Record) equalContent(other Record) bool {
	return r.Tombstone == other.Tombstone && string(r.Value) == string(other.Value)
}

type readerState struct {
	snapshot   uint64
	generation uint64
}

// Store is a versioned key-value table. It is safe for concurrent use.
type Store struct {
	mu         sync.RWMutex
	data       map[string][]Record // per key, sorted by Seq ascending
	readers    map[int]readerState
	nextReader int
	generation uint64
	horizon    uint64 // compaction horizon: snapshots below it are rejected
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{
		data:    make(map[string][]Record),
		readers: make(map[int]readerState),
	}
}

// commit inserts rec into the history of key, rejecting conflicting content
// at an already-committed sequence number. Identical re-commits are no-ops.
func (s *Store) commit(key string, rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	hist := s.data[key]
	i := sort.Search(len(hist), func(i int) bool { return hist[i].Seq >= rec.Seq })
	if i < len(hist) && hist[i].Seq == rec.Seq {
		if !hist[i].equalContent(rec) {
			return ErrConflict
		}
		return nil
	}
	if rec.Value != nil {
		rec.Value = append([]byte(nil), rec.Value...)
	}
	hist = append(hist, Record{})
	copy(hist[i+1:], hist[i:])
	hist[i] = rec
	s.data[key] = hist
	return nil
}

// Put commits value for key at the given sequence number.
func (s *Store) Put(key string, seq uint64, value []byte) error {
	return s.commit(key, Record{Seq: seq, Value: value})
}

// Delete commits a tombstone for key at the given sequence number.
func (s *Store) Delete(key string, seq uint64) error {
	return s.commit(key, Record{Seq: seq, Tombstone: true})
}

// getAt returns the record visible at snapshotSeq: the most recent record
// with Seq <= snapshotSeq.
func getAt(hist []Record, snapshotSeq uint64) (Record, bool) {
	i := sort.Search(len(hist), func(i int) bool { return hist[i].Seq > snapshotSeq }) - 1
	if i < 0 {
		return Record{}, false
	}
	return hist[i], true
}

// Reader is a registered snapshot view of the store. A reader keeps the
// records it can observe alive across compactions until it is released or
// its generation expires.
type Reader struct {
	store      *Store
	id         int
	snapshot   uint64
	generation uint64
}

// RegisterReader registers a snapshot reader at snapshotSeq in the current
// generation. Compaction preserves every record observable by live readers.
// It fails with ErrSnapshotTooOld if snapshotSeq is below the compaction
// horizon (see MinSnapshot).
func (s *Store) RegisterReader(snapshotSeq uint64) (*Reader, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if snapshotSeq < s.horizon {
		return nil, ErrSnapshotTooOld
	}
	id := s.nextReader
	s.nextReader++
	s.readers[id] = readerState{snapshot: snapshotSeq, generation: s.generation}
	return &Reader{store: s, id: id, snapshot: snapshotSeq, generation: s.generation}, nil
}

// MinSnapshot returns the compaction horizon: the smallest snapshot sequence
// at which new readers may register. Compaction guarantees that reads at or
// above the horizon observe the same results as the full history would give.
func (s *Store) MinSnapshot() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.horizon
}

// Snapshot returns the reader's snapshot sequence number.
func (r *Reader) Snapshot() uint64 { return r.snapshot }

// Release unregisters the reader; records kept alive solely for it become
// eligible for compaction.
func (r *Reader) Release() {
	r.store.mu.Lock()
	defer r.store.mu.Unlock()
	delete(r.store.readers, r.id)
}

// AdvanceGeneration moves the store to a new reader generation, expiring
// every reader registered in earlier generations. Expired readers fail with
// ErrReaderClosed and no longer pin records during compaction.
func (s *Store) AdvanceGeneration() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	for id, st := range s.readers {
		if st.generation != s.generation {
			delete(s.readers, id)
		}
	}
}

// Get returns the value visible to this reader for key, or ok=false if the
// key has no visible record or its visible record is a tombstone.
func (r *Reader) Get(key string) (value []byte, ok bool, err error) {
	r.store.mu.RLock()
	defer r.store.mu.RUnlock()
	st, live := r.store.readers[r.id]
	if !live || st.generation != r.store.generation {
		return nil, false, ErrReaderClosed
	}
	rec, found := getAt(r.store.data[key], r.snapshot)
	if !found || rec.Tombstone {
		return nil, false, nil
	}
	return append([]byte(nil), rec.Value...), true, nil
}

// Compact drops records that no live reader and no future reader at or above
// the horizon can observe. For each key it keeps every record newer than the
// oldest live snapshot (or the horizon when no readers are live) plus the
// newest record at or below it. Keys whose only remaining record is a
// tombstone are removed. The horizon advances to the oldest live snapshot,
// or to the newest committed sequence when no readers are live.
func (s *Store) Compact() {
	s.mu.Lock()
	defer s.mu.Unlock()
	floor := s.horizon
	haveReader := false
	for _, st := range s.readers {
		if st.generation != s.generation {
			continue
		}
		if !haveReader || st.snapshot < floor {
			floor = st.snapshot
		}
		haveReader = true
	}
	if !haveReader {
		// With no live readers only the newest record per key survives, so
		// future snapshots must be at or above the newest committed seq.
		for _, hist := range s.data {
			if n := hist[len(hist)-1].Seq; n > floor {
				floor = n
			}
		}
	}
	for key, hist := range s.data {
		var keepFrom int
		if haveReader {
			// First record with Seq > floor, then back off by one to
			// include the newest record at or below the oldest snapshot.
			keepFrom = sort.Search(len(hist), func(i int) bool { return hist[i].Seq > floor })
			if keepFrom > 0 {
				keepFrom--
			}
		} else {
			keepFrom = len(hist) - 1
		}
		kept := append([]Record(nil), hist[keepFrom:]...)
		if len(kept) == 1 && kept[0].Tombstone {
			delete(s.data, key)
			continue
		}
		s.data[key] = kept
	}
	s.horizon = floor
}

// Len returns the number of records retained for key; used by tests.
func (s *Store) Len(key string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.data[key])
}
