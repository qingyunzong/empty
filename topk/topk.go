// Package topk implements a retractable Top-K ranking component for a
// real-time ranking service.
//
// Records carry positive (add) or negative (retract) weights over a
// multiset keyed by a stable string key. Members are ranked by score
// (descending), then event time (ascending), then the stable key
// (ascending). Retracting a current member backfills from the candidate
// set and reports the minimal membership change. A retraction that would
// drive a key's multiplicity negative is rejected and leaves the state
// untouched.
//
// State is shardable: independent shards accept disjoint subsets of the
// record stream, and merging their states yields exactly the same Top-K
// as applying the full stream to a single state.
package topk

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
)

// ErrNegativeMultiplicity is returned when a retraction would drop a
// key's multiplicity below zero. The state is left unchanged.
var ErrNegativeMultiplicity = errors.New("topk: negative multiplicity rejected")

// Record is a single weighted update to the ranking multiset.
//
// Weight > 0 adds occurrences of Key with the given attributes;
// Weight < 0 retracts occurrences; Weight == 0 is a no-op.
type Record struct {
	Key       string
	Score     float64
	EventTime int64
	Weight    int64
}

// Attr holds the ranking attributes associated with a key.
type Attr struct {
	Score     float64
	EventTime int64
}

// betterAttr reports whether a supersedes b when the same key is added
// with conflicting attributes: the later event time wins, then the
// higher score. The rule is commutative and associative, which makes
// sharded merging order-independent.
func betterAttr(a, b Attr) bool {
	if a.EventTime != b.EventTime {
		return a.EventTime > b.EventTime
	}
	return a.Score > b.Score
}

// Entry is one ranked member: a live key, its attributes, and its
// current multiplicity.
type Entry struct {
	Key          string
	Attr         Attr
	Multiplicity int64
}

// compareEntries ranks entries: score descending, event time ascending
// (earlier wins), key ascending as the stable tiebreak.
func compareEntries(a, b Entry) int {
	if c := cmp.Compare(b.Attr.Score, a.Attr.Score); c != 0 {
		return c
	}
	if c := cmp.Compare(a.Attr.EventTime, b.Attr.EventTime); c != 0 {
		return c
	}
	return cmp.Compare(a.Key, b.Key)
}

// State is the mergeable multiset backing the ranking. The zero value
// is not ready for use; create one with NewState.
type State struct {
	mult map[string]int64
	attr map[string]Attr
}

// NewState returns an empty, ready-to-use State.
func NewState() *State {
	return &State{
		mult: make(map[string]int64),
		attr: make(map[string]Attr),
	}
}

// Apply folds one record into the multiset. A retraction that would
// make the key's multiplicity negative returns ErrNegativeMultiplicity
// and leaves the state unchanged.
func (s *State) Apply(r Record) error {
	if r.Weight == 0 {
		return nil
	}
	next := s.mult[r.Key] + r.Weight
	if next < 0 {
		return fmt.Errorf("%w: key %q would drop to %d", ErrNegativeMultiplicity, r.Key, next)
	}
	if next == 0 {
		delete(s.mult, r.Key)
		delete(s.attr, r.Key)
		return nil
	}
	s.mult[r.Key] = next
	if r.Weight > 0 {
		a := Attr{Score: r.Score, EventTime: r.EventTime}
		if cur, ok := s.attr[r.Key]; !ok || betterAttr(a, cur) {
			s.attr[r.Key] = a
		}
	}
	return nil
}

// Multiplicity returns the current multiplicity of key.
func (s *State) Multiplicity(key string) int64 {
	return s.mult[key]
}

// Clone returns a deep copy of the state.
func (s *State) Clone() *State {
	c := NewState()
	for k, m := range s.mult {
		c.mult[k] = m
	}
	for k, a := range s.attr {
		c.attr[k] = a
	}
	return c
}

// Merge folds other into s. Both states hold non-negative
// multiplicities, so merged multiplicities are plain sums and the
// result is identical to applying both record streams to one state.
// Merge is commutative and associative, so shards may be merged in any
// order and grouping.
func (s *State) Merge(other *State) {
	for k, m := range other.mult {
		s.mult[k] += m
	}
	for k, a := range other.attr {
		if cur, ok := s.attr[k]; !ok || betterAttr(a, cur) {
			s.attr[k] = a
		}
	}
}

// Entries returns every live key in rank order.
func (s *State) Entries() []Entry {
	entries := make([]Entry, 0, len(s.mult))
	for k, m := range s.mult {
		entries = append(entries, Entry{Key: k, Attr: s.attr[k], Multiplicity: m})
	}
	slices.SortFunc(entries, compareEntries)
	return entries
}

// TopK returns the k highest-ranked entries, or all of them if fewer
// than k keys are live. k <= 0 returns nil.
func (s *State) TopK(k int) []Entry {
	if k <= 0 {
		return nil
	}
	entries := s.Entries()
	if len(entries) > k {
		entries = entries[:k]
	}
	return entries
}

// ChangeKind identifies how a Top-K member is affected by an update.
type ChangeKind int

const (
	// Entered marks a key that joined the Top-K (new or backfilled).
	Entered ChangeKind = iota
	// Left marks a key that dropped out of the Top-K (retracted or
	// displaced).
	Left
	// Updated marks a key that stayed in the Top-K but whose
	// attributes changed.
	Updated
)

func (k ChangeKind) String() string {
	switch k {
	case Entered:
		return "entered"
	case Left:
		return "left"
	case Updated:
		return "updated"
	}
	return "unknown"
}

// Change describes one minimal membership change to the Top-K.
type Change struct {
	Kind  ChangeKind
	Entry Entry
}

// diffTop computes the minimal change set between two ranked Top-K
// snapshots: departures in old rank order, then updates and arrivals in
// new rank order.
func diffTop(oldTop, newTop []Entry) []Change {
	oldByKey := make(map[string]Entry, len(oldTop))
	for _, e := range oldTop {
		oldByKey[e.Key] = e
	}
	newByKey := make(map[string]Entry, len(newTop))
	for _, e := range newTop {
		newByKey[e.Key] = e
	}

	var changes []Change
	for _, e := range oldTop {
		if _, ok := newByKey[e.Key]; !ok {
			changes = append(changes, Change{Kind: Left, Entry: e})
		}
	}
	for _, e := range newTop {
		old, ok := oldByKey[e.Key]
		switch {
		case !ok:
			changes = append(changes, Change{Kind: Entered, Entry: e})
		case old.Attr != e.Attr:
			changes = append(changes, Change{Kind: Updated, Entry: e})
		}
	}
	return changes
}

// Ranker maintains a live Top-K over a State and reports the minimal
// membership change for every applied record.
type Ranker struct {
	k     int
	state *State
	top   []Entry
}

// NewRanker returns a Ranker tracking the top k keys of an empty state.
func NewRanker(k int) *Ranker {
	return NewRankerFromState(k, NewState())
}

// NewRankerFromState returns a Ranker tracking the top k keys of an
// existing (possibly merged) state.
func NewRankerFromState(k int, s *State) *Ranker {
	if k < 0 {
		k = 0
	}
	return &Ranker{k: k, state: s, top: s.TopK(k)}
}

// Apply folds one record into the underlying state and returns the
// minimal change to the Top-K. If the record is rejected, the error is
// returned, the state is unchanged, and no changes are reported.
func (r *Ranker) Apply(rec Record) ([]Change, error) {
	if err := r.state.Apply(rec); err != nil {
		return nil, err
	}
	next := r.state.TopK(r.k)
	changes := diffTop(r.top, next)
	r.top = next
	return changes, nil
}

// Top returns the current Top-K in rank order.
func (r *Ranker) Top() []Entry {
	return slices.Clone(r.top)
}

// State exposes the underlying multiset, e.g. to serve as one shard or
// to merge shard states into a global view.
func (r *Ranker) State() *State {
	return r.state
}
