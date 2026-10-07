package preimage

import "fmt"

// Store keeps every committed version of a Map. Patching never mutates
// existing versions, so historical preimage queries remain reproducible.
type Store struct {
	versions map[uint64]Map
	latest   uint64
}

// NewStore commits base as version 1.
func NewStore(base Map) *Store {
	s := &Store{versions: make(map[uint64]Map)}
	s.versions[1] = base
	s.latest = 1
	return s
}

// Latest returns the newest committed version number.
func (s *Store) Latest() uint64 { return s.latest }

// Get returns the map committed at version v.
func (s *Store) Get(v uint64) (Map, bool) {
	m, ok := s.versions[v]
	return m, ok
}

// Patch applies edits to the latest version and commits the result as a
// new version. Each edit replaces the branches covering its domain; edit
// domains must be non-empty, pairwise non-overlapping, and contained in
// the map domain. Edits may split existing pieces at their boundaries.
func (s *Store) Patch(edits []Piece) (uint64, error) {
	next, err := Patch(s.versions[s.latest], edits)
	if err != nil {
		return 0, err
	}
	s.latest++
	s.versions[s.latest] = next
	return s.latest, nil
}

// Patch returns a new Map with the given edits applied to m, leaving m
// unchanged. Edit domains replace existing coverage; the rest of the
// domain keeps its current branches.
func Patch(m Map, edits []Piece) (Map, error) {
	cuts := make([]Interval, 0, len(edits))
	for _, e := range edits {
		if e.Dom.Empty() {
			return Map{}, fmt.Errorf("preimage: empty edit domain %v", e.Dom)
		}
		if !coveredBy(e.Dom, m.dom) {
			return Map{}, fmt.Errorf("preimage: edit domain %v outside map domain %v", e.Dom, m.dom)
		}
		cuts = append(cuts, e.Dom)
	}
	merged := Canonicalize(cuts)
	if totalLen(merged) != totalLen(cuts) {
		return Map{}, fmt.Errorf("preimage: overlapping edit domains")
	}

	var pieces []Piece
	for _, p := range m.pieces {
		// Subtract edit domains from the existing piece, keeping its
		// affine on the surviving sub-intervals.
		cursor := p.Dom.Lo
		for _, cut := range merged {
			ov := Intersect(p.Dom, cut)
			if ov.Empty() {
				continue
			}
			if cursor < ov.Lo {
				pieces = append(pieces, Piece{Dom: Interval{Lo: cursor, Hi: ov.Lo}, F: p.F})
			}
			cursor = ov.Hi
		}
		if cursor < p.Dom.Hi {
			pieces = append(pieces, Piece{Dom: Interval{Lo: cursor, Hi: p.Dom.Hi}, F: p.F})
		}
	}
	pieces = append(pieces, edits...)
	return NewMap(pieces)
}

func coveredBy(iv, dom Interval) bool { return iv.Lo >= dom.Lo && iv.Hi <= dom.Hi }

func totalLen(ivs []Interval) int64 {
	var n int64
	for _, iv := range ivs {
		n += iv.Len()
	}
	return n
}
