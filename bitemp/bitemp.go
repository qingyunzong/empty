// Package bitemp implements a bitemporal authorization rule store.
//
// Every rule revision carries two time axes:
//   - valid time: [ValidFrom, ValidTo) — when the rule is in effect in the world;
//   - transaction time: CommittedAt — when the revision became known to the system.
//
// Historical queries take an as-of transaction time and never see revisions
// committed after it. Revocations are recorded on the transaction axis; the
// revoked revision stays in the append-only log (source retained) but stops
// matching queries at or after its RevokedAt. When several revisions cover
// the same valid instant, the most recently committed one wins.
package bitemp

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// ErrOpenInterval is returned when a rule has a non-positive valid interval.
var ErrOpenInterval = errors.New("bitemp: ValidTo must be after ValidFrom (zero means open-ended)")

// Rule is one immutable revision of an authorization rule.
type Rule struct {
	ID          string     // rule identity shared by all revisions
	Version     int        // 1-based, assigned by Store.Commit in commit order
	Payload     string     // authorization decision content (the "source")
	ValidFrom   time.Time  // inclusive start of the valid-time interval
	ValidTo     time.Time  // exclusive end; zero value means open-ended
	CommittedAt time.Time  // transaction-time commit instant
	RevokedAt   *time.Time // transaction-time revocation; nil while live
}

// Effective reports whether r is visible for a query at (validAt, asOf).
func (r Rule) Effective(validAt, asOf time.Time) bool {
	if r.CommittedAt.After(asOf) {
		return false // future commit: invisible to historical queries
	}
	if r.RevokedAt != nil && !r.RevokedAt.After(asOf) {
		return false // revoked at or before as-of
	}
	if validAt.Before(r.ValidFrom) {
		return false
	}
	if !r.ValidTo.IsZero() && !validAt.Before(r.ValidTo) {
		return false
	}
	return true
}

// Store is an append-only bitemporal log of rule revisions.
type Store struct {
	log        []Rule           // every revision ever committed, in commit order
	byID       map[string][]int // indexes into log, kept sorted by (CommittedAt, Version)
	nextVer    map[string]int
	lastCommit time.Time // transaction-time clock; commits must not go backwards
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{
		byID:    make(map[string][]int),
		nextVer: make(map[string]int),
	}
}

// Commit validates and appends a new revision, assigning its version.
// The supplied Version and RevokedAt fields are ignored/reset.
func (s *Store) Commit(r Rule) (Rule, error) {
	if r.ID == "" {
		return Rule{}, errors.New("bitemp: rule ID required")
	}
	if !r.ValidTo.IsZero() && !r.ValidTo.After(r.ValidFrom) {
		return Rule{}, ErrOpenInterval
	}
	if r.CommittedAt.Before(s.lastCommit) {
		return Rule{}, fmt.Errorf("bitemp: CommittedAt %s before store clock %s", r.CommittedAt, s.lastCommit)
	}
	s.lastCommit = r.CommittedAt
	s.nextVer[r.ID]++
	r.Version = s.nextVer[r.ID]
	r.RevokedAt = nil
	s.log = append(s.log, r)
	idx := len(s.log) - 1
	s.byID[r.ID] = append(s.byID[r.ID], idx)
	return r, nil
}

// Revoke marks the latest committed revision of id as revoked at tx time at.
// The revision itself is kept in the log with its payload (source retained).
func (s *Store) Revoke(id string, at time.Time) error {
	idxs := s.byID[id]
	if len(idxs) == 0 {
		return fmt.Errorf("bitemp: unknown rule %q", id)
	}
	last := &s.log[idxs[len(idxs)-1]]
	if last.RevokedAt != nil {
		return fmt.Errorf("bitemp: rule %q already revoked", id)
	}
	atCopy := at
	last.RevokedAt = &atCopy
	return nil
}

// Query returns the winning revision for id at (validAt, asOf).
// Winner = visible revision with the latest CommittedAt; ties break to the
// higher Version (later commit wins — the most recent effective layer).
func (s *Store) Query(id string, validAt, asOf time.Time) (Rule, bool) {
	idxs := s.byID[id]
	// Scan newest-first; the index is sorted by commit order, so the first
	// visible hit is the most recently committed effective layer.
	for i := len(idxs) - 1; i >= 0; i-- {
		r := s.log[idxs[i]]
		if r.Effective(validAt, asOf) {
			return r, true
		}
	}
	return Rule{}, false
}

// History returns every revision of id visible in the log (including revoked
// ones, with their source payload), in commit order.
func (s *Store) History(id string) []Rule {
	var out []Rule
	for _, idx := range s.byID[id] {
		out = append(out, s.log[idx])
	}
	return out
}

// Recompute is the reference implementation: a full linear scan of the raw
// log with no index. Tests cross-check Query against it over a 2-D time grid.
func (s *Store) Recompute(id string, validAt, asOf time.Time) (Rule, bool) {
	var best Rule
	found := false
	for _, r := range s.log {
		if r.ID != id || !r.Effective(validAt, asOf) {
			continue
		}
		if !found || r.CommittedAt.After(best.CommittedAt) ||
			(r.CommittedAt.Equal(best.CommittedAt) && r.Version > best.Version) {
			best, found = r, true
		}
	}
	return best, found
}

// GridPoints collects every meaningful instant on both axes (interval edges,
// commits, revocations) plus their ±1ns neighbours, so a grid sweep covers
// all boundary semantics.
func (s *Store) GridPoints() []time.Time {
	seen := map[time.Time]bool{}
	var pts []time.Time
	add := func(t time.Time) {
		for _, c := range []time.Time{t.Add(-time.Nanosecond), t, t.Add(time.Nanosecond)} {
			if !seen[c] {
				seen[c] = true
				pts = append(pts, c)
			}
		}
	}
	for _, r := range s.log {
		add(r.ValidFrom)
		if !r.ValidTo.IsZero() {
			add(r.ValidTo)
		}
		add(r.CommittedAt)
		if r.RevokedAt != nil {
			add(*r.RevokedAt)
		}
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].Before(pts[j]) })
	return pts
}
