// Package bitemp implements a bitemporal version store.
//
// The store receives correction records grouped into commits. Each
// correction covers a half-open business-time (valid-time) interval
// [ValidFrom, ValidTo). Commits are appended in commit-time order and
// history along the commit-time axis is never rewritten: a correction
// supersedes earlier corrections only for queries whose commit time is
// at or after the correction's own commit.
//
// Deletions are corrections too: a delete carries its own valid-time
// interval and is visible only inside it.
//
// Point queries are two-dimensional: Query(key, validTime, commitTime)
// returns the value visible at that business time as of that commit
// time, together with the ID of the commit the value originates from.
package bitemp

import (
	"errors"
	"fmt"
	"sort"
)

// Correction is a single correction record inside a commit.
// The business-time interval is half-open: [ValidFrom, ValidTo).
// A correction with Delete set erases the key inside its interval.
type Correction struct {
	Key       string
	ValidFrom int64
	ValidTo   int64 // exclusive
	Value     string
	Delete    bool
}

// ErrEmptyInterval is returned when a correction's valid interval is empty.
var ErrEmptyInterval = errors.New("bitemp: valid interval must satisfy ValidFrom < ValidTo")

// segment is one stored correction. Segments are append-only; overlapping
// segments from different commits coexist and are resolved at query time.
type segment struct {
	from, to  int64
	rev       int // global revision, strictly increasing per correction
	commitSeq int // 1-based sequence number of the owning commit
	value     string
	deleted   bool
}

// commitMeta records one accepted commit on the commit-time axis.
type commitMeta struct {
	seq  int
	id   string
	time int64
}

// Store is a bitemporal version store. It is not safe for concurrent use.
type Store struct {
	segments map[string][]segment // per key, append-only
	commits  []commitMeta         // ordered by seq, commit times non-decreasing
	rev      int
}

// NewStore returns an empty Store.
func NewStore() *Store {
	return &Store{segments: make(map[string][]segment)}
}

// AddCommit appends a commit with the given ID and commit time.
// Commit times must be non-decreasing. Corrections inside one commit are
// applied in slice order: a later correction wins over an earlier one
// where their valid intervals overlap.
func (s *Store) AddCommit(id string, commitTime int64, corrections []Correction) error {
	if n := len(s.commits); n > 0 && commitTime < s.commits[n-1].time {
		return fmt.Errorf("bitemp: commit time %d goes backwards (last %d)", commitTime, s.commits[n-1].time)
	}
	for _, c := range corrections {
		if c.ValidFrom >= c.ValidTo {
			return ErrEmptyInterval
		}
	}
	seq := len(s.commits) + 1
	s.commits = append(s.commits, commitMeta{seq: seq, id: id, time: commitTime})
	for _, c := range corrections {
		s.rev++
		s.segments[c.Key] = append(s.segments[c.Key], segment{
			from:      c.ValidFrom,
			to:        c.ValidTo,
			rev:       s.rev,
			commitSeq: seq,
			value:     c.Value,
			deleted:   c.Delete,
		})
	}
	return nil
}

// commitSeqAt returns the sequence number of the newest commit whose
// commit time is <= commitTime, or 0 if there is none.
func (s *Store) commitSeqAt(commitTime int64) int {
	i := sort.Search(len(s.commits), func(i int) bool {
		return s.commits[i].time > commitTime
	})
	return i // commits[i-1] is the newest with time <= commitTime; seq == i
}

// Query returns the value of key visible at validTime as of commitTime.
// ok is false when the key is absent or deleted at that bitemporal point.
// When ok is true, commitID identifies the commit the value came from.
func (s *Store) Query(key string, validTime, commitTime int64) (value string, commitID string, ok bool) {
	seq := s.commitSeqAt(commitTime)
	if seq == 0 {
		return "", "", false
	}
	best := -1
	for i, seg := range s.segments[key] {
		if seg.commitSeq > seq {
			continue
		}
		if seg.from <= validTime && validTime < seg.to {
			if best == -1 || seg.rev > s.segments[key][best].rev {
				best = i
			}
		}
	}
	if best == -1 || s.segments[key][best].deleted {
		return "", "", false
	}
	seg := s.segments[key][best]
	return seg.value, s.commits[seg.commitSeq-1].id, true
}
