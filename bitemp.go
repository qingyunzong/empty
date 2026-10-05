// Package bitemp implements a bitemporal authorization-rule store.
//
// Every rule revision carries two time axes:
//   - valid time: the interval [ValidFrom, ValidTo) in which the rule
//     decision is in effect in the world being modeled;
//   - transaction time: the commit sequence (Seq) at which the revision
//     became known to the store.
//
// Queries are evaluated at a (validAt, asOfSeq) point. A historical query
// never sees revisions committed after asOfSeq. Retractions are ordinary
// revisions: they shadow the layer they target but never delete history,
// so the provenance (Source) of every record is preserved. When several
// layers cover validAt, the layer with the most recent ValidFrom decides.
package bitemp

import (
	"errors"
	"fmt"
	"time"
)

// Revision is one committed version of a rule layer.
type Revision struct {
	Seq       int64     // commit order, assigned by the store (tx-time axis)
	Key       string    // rule subject, e.g. "user:42/resource:7"
	ValidFrom time.Time // inclusive start of the valid-time interval
	ValidTo   time.Time // exclusive end; zero value means open-ended
	Decision  string    // e.g. "allow" or "deny"; empty on retractions
	Retracted bool      // true if this revision retracts its layer
	Source    string    // provenance: who/what produced this record
}

// ValidEnd returns the exclusive end of the valid interval, mapping the
// zero value to "forever".
func (r Revision) ValidEnd() time.Time {
	if r.ValidTo.IsZero() {
		return time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
	}
	return r.ValidTo
}

// Covers reports whether validAt lies in [ValidFrom, ValidEnd).
func (r Revision) Covers(validAt time.Time) bool {
	return !validAt.Before(r.ValidFrom) && validAt.Before(r.ValidEnd())
}

// Hit is the outcome of resolving a query point.
type Hit struct {
	Revision Revision // winning revision (its Seq is the hit version)
	Active   bool     // false when the winning layer is a retraction
}

// Store is an append-only bitemporal rule store. It is not safe for
// concurrent use.
type Store struct {
	seq   int64
	revs  []Revision       // every revision ever committed, in commit order
	byKey map[string][]int // key -> indexes into revs, in commit order
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{byKey: make(map[string][]int)}
}

var errEmptyKey = errors.New("bitemp: key must not be empty")

// Commit appends a new revision for rev.Key and returns it with its
// assigned Seq. ValidTo may be zero (open-ended); a non-zero ValidTo must
// be after ValidFrom.
func (s *Store) Commit(rev Revision) (Revision, error) {
	if rev.Key == "" {
		return Revision{}, errEmptyKey
	}
	if !rev.ValidTo.IsZero() && !rev.ValidTo.After(rev.ValidFrom) {
		return Revision{}, fmt.Errorf("bitemp: ValidTo %s not after ValidFrom %s", rev.ValidTo, rev.ValidFrom)
	}
	if rev.Retracted {
		rev.Decision = ""
	}
	s.seq++
	rev.Seq = s.seq
	s.revs = append(s.revs, rev)
	s.byKey[rev.Key] = append(s.byKey[rev.Key], len(s.revs)-1)
	return rev, nil
}

// Retract commits a retraction of the layer (Key, ValidFrom), recording
// source as the provenance of the retraction itself. The retracted
// revisions remain in history untouched.
func (s *Store) Retract(key string, validFrom time.Time, source string) (Revision, error) {
	return s.Commit(Revision{
		Key:       key,
		ValidFrom: validFrom,
		Retracted: true,
		Source:    source,
	})
}

// Revisions returns all committed revisions for key in commit order.
// Historical queries at any asOfSeq are answered from this untouched log.
func (s *Store) Revisions(key string) []Revision {
	idxs := s.byKey[key]
	out := make([]Revision, 0, len(idxs))
	for _, i := range idxs {
		out = append(out, s.revs[i])
	}
	return out
}

// Query resolves key at (validAt, asOfSeq). Only revisions with
// Seq <= asOfSeq participate, so a historical query can never observe a
// future commit. Corrections within one layer (same ValidFrom) are
// resolved in favor of the latest visible commit; across layers the most
// recent ValidFrom covering validAt wins. If the winning layer's visible
// revision is a retraction, the hit is returned with Active == false and
// lower layers stay shadowed.
func (s *Store) Query(key string, validAt time.Time, asOfSeq int64) (Hit, bool) {
	idxs := s.byKey[key]
	if len(idxs) == 0 {
		return Hit{}, false
	}
	// Fold each layer to its latest visible revision first; only that
	// revision defines the layer's valid interval at asOfSeq. Revisions
	// are stored in commit order, so the last visible one per layer wins.
	latest := make(map[time.Time]*Revision, len(idxs))
	order := make([]time.Time, 0, len(idxs))
	for _, i := range idxs {
		rev := &s.revs[i]
		if rev.Seq > asOfSeq {
			continue // future commit: invisible to this query
		}
		if _, ok := latest[rev.ValidFrom]; !ok {
			order = append(order, rev.ValidFrom)
		}
		latest[rev.ValidFrom] = rev
	}
	// Among layers covering validAt, the most recent valid layer decides.
	var best *Revision
	for _, from := range order {
		rev := latest[from]
		if !rev.Covers(validAt) {
			continue
		}
		if best == nil || rev.ValidFrom.After(best.ValidFrom) {
			best = rev
		}
	}
	if best == nil {
		return Hit{}, false
	}
	return Hit{Revision: *best, Active: !best.Retracted}, true
}
