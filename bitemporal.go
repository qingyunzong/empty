// Package bitemporal implements an append-only versioned store with two
// time axes: business time (when a fact is valid in the real world) and
// commit time (when the fact became known to the system).
//
// Corrections arrive in commits. Each correction states that a key holds a
// value (or is deleted) over a half-open business-time interval [From, To).
// Later commits supersede earlier ones wherever their business-time
// intervals overlap, but commit-time history is never rewritten: querying
// with an older commit time replays the past exactly.
package bitemporal

import (
	"errors"
	"sort"
	"sync"
)

// Correction is a single change record inside a commit. It asserts that Key
// maps to Value over the half-open business-time interval [From, To).
// A correction with Delete set is a tombstone: the key has no value over
// [From, To), but the tombstone itself still occupies that interval and
// hides anything written by earlier commits.
type Correction struct {
	Key    string
	From   int64 // business time, inclusive
	To     int64 // business time, exclusive
	Value  string
	Delete bool
}

// Result is the outcome of a point query on the two time axes.
type Result struct {
	Found    bool   // whether a live (non-deleted) value is visible
	Value    string // the visible value, valid only when Found is true
	CommitID int    // ID of the commit that produced the visible record
}

var ErrEmptyInterval = errors.New("bitemporal: correction with empty or inverted interval")

type version struct {
	commitID int
	from     int64
	to       int64
	value    string
	delete   bool
}

// DB is an append-only bitemporal store. It is safe for concurrent use.
type DB struct {
	mu     sync.RWMutex
	nextID int
	keys   map[string][]version // per key, versions ordered by ascending commit ID
}

// New returns an empty store.
func New() *DB {
	return &DB{keys: make(map[string][]version)}
}

// Commit appends a batch of corrections atomically and returns the new
// commit ID. Commit IDs are strictly increasing, starting at 1, and define
// the commit-time axis. Corrections within one commit are applied in slice
// order; if two corrections in the same commit overlap on the same key, the
// later one wins for the overlapping region.
func (db *DB) Commit(cs []Correction) (int, error) {
	for _, c := range cs {
		if c.From >= c.To {
			return 0, ErrEmptyInterval
		}
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	db.nextID++
	id := db.nextID
	for _, c := range cs {
		db.keys[c.Key] = append(db.keys[c.Key], version{
			commitID: id,
			from:     c.From,
			to:       c.To,
			value:    c.Value,
			delete:   c.Delete,
		})
	}
	return id, nil
}

// Get resolves key at the given business time as known at the given commit
// time. Among all corrections with CommitID <= commitTime whose interval
// covers businessTime, the one from the newest commit wins; within one
// commit, the correction appended last wins. A winning tombstone yields
// Found == false but still reports its CommitID.
func (db *DB) Get(key string, businessTime int64, commitTime int) Result {
	db.mu.RLock()
	defer db.mu.RUnlock()
	vs := db.keys[key]
	// Versions are appended in commit order, so the visible prefix is a
	// binary-searchable range.
	visible := sort.Search(len(vs), func(i int) bool { return vs[i].commitID > commitTime })
	best := -1
	for i := 0; i < visible; i++ {
		if vs[i].from <= businessTime && businessTime < vs[i].to {
			best = i // ascending commit order: last covering version wins
		}
	}
	if best < 0 {
		return Result{}
	}
	v := vs[best]
	if v.delete {
		return Result{CommitID: v.commitID}
	}
	return Result{Found: true, Value: v.value, CommitID: v.commitID}
}
