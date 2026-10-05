package coverage

import "sort"

// Store is a mutable collection of weighted intervals grouped by source
// ID. A source may own any number of intervals; removing a source
// withdraws all of them at once. The zero value is ready to use.
type Store struct {
	srcs map[string][]Interval
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{srcs: make(map[string][]Interval)}
}

func (s *Store) ensure() {
	if s.srcs == nil {
		s.srcs = make(map[string][]Interval)
	}
}

// Add appends ivs to source, dropping empty (zero-length) intervals.
// The receiver never mutates slices shared with snapshots: the source's
// interval list is copied before it is extended.
func (s *Store) Add(source string, ivs ...Interval) {
	s.ensure()
	clean := make([]Interval, 0, len(ivs))
	for _, iv := range ivs {
		if iv.L < iv.R {
			clean = append(clean, iv)
		}
	}
	if len(clean) == 0 {
		return
	}
	old := s.srcs[source]
	nv := make([]Interval, 0, len(old)+len(clean))
	nv = append(nv, old...)
	nv = append(nv, clean...)
	s.srcs[source] = nv
}

// Remove deletes every interval belonging to source and reports whether
// the source existed.
func (s *Store) Remove(source string) bool {
	if _, ok := s.srcs[source]; !ok {
		return false
	}
	delete(s.srcs, source)
	return true
}

// Snapshot returns an independent branch of the store. Later mutations
// of either store never affect the other.
func (s *Store) Snapshot() *Store {
	s.ensure()
	nv := make(map[string][]Interval, len(s.srcs))
	for k, v := range s.srcs {
		nv[k] = v
	}
	return &Store{srcs: nv}
}

// Sources returns the sorted source IDs currently present.
func (s *Store) Sources() []string {
	out := make([]string, 0, len(s.srcs))
	for src := range s.srcs {
		out = append(out, src)
	}
	sort.Strings(out)
	return out
}

// Segments returns the canonical segmentation: the maximal
// constant-coverage segments in coordinate order, each with source
// evidence.
func (s *Store) Segments() []Segment {
	return segmentsFrom(s.srcs)
}

// Total returns the coverage total: the integral of coverage over the
// line, equivalently the sum of length*weight over all stored intervals.
func (s *Store) Total() int64 {
	var total int64
	for _, seg := range s.Segments() {
		total += seg.Sum * int64(seg.R-seg.L)
	}
	return total
}

// Max returns the maximum coverage and the earliest position reaching
// it. ok is false when the store holds no interval; max is 0 then.
func (s *Store) Max() (max int64, pos int, ok bool) {
	segs := s.Segments()
	if len(segs) == 0 {
		return 0, 0, false
	}
	max, pos = segs[0].Sum, segs[0].L
	for _, seg := range segs[1:] {
		if seg.Sum > max {
			max, pos = seg.Sum, seg.L
		}
	}
	return max, pos, true
}

// MaxSegments returns every segment attaining the maximum coverage, each
// carrying its source evidence. It returns nil for an empty store.
func (s *Store) MaxSegments() []Segment {
	max, _, ok := s.Max()
	if !ok {
		return nil
	}
	var out []Segment
	for _, seg := range s.Segments() {
		if seg.Sum == max {
			out = append(out, seg)
		}
	}
	return out
}

// Op is one batch modification: either the removal of a whole source or
// the addition of intervals to it.
type Op struct {
	Source string
	Remove bool
	Ivs    []Interval
}

// AddOp returns an Op adding ivs to source.
func AddOp(source string, ivs ...Interval) Op {
	return Op{Source: source, Ivs: ivs}
}

// RemoveOp returns an Op withdrawing the whole source.
func RemoveOp(source string) Op {
	return Op{Source: source, Remove: true}
}

// Patch is an inverse patch returned by Apply. Reverting it restores the
// exact state the store had before the batch was applied.
type Patch struct {
	prior []priorSource
}

// priorSource records the pre-image of one touched source.
type priorSource struct {
	source  string
	ivs     []Interval
	existed bool
}

// Apply executes ops in order and returns the inverse patch.
func (s *Store) Apply(ops ...Op) Patch {
	s.ensure()
	p := Patch{prior: make([]priorSource, 0, len(ops))}
	for _, op := range ops {
		old, ok := s.srcs[op.Source]
		p.prior = append(p.prior, priorSource{source: op.Source, ivs: old, existed: ok})
		if op.Remove {
			delete(s.srcs, op.Source)
		} else {
			s.Add(op.Source, op.Ivs...)
		}
	}
	return p
}

// Revert undoes a patch previously returned by Apply on this store.
// Sources are restored in reverse application order, so batches touching
// the same source several times revert correctly.
func (s *Store) Revert(p Patch) {
	s.ensure()
	for i := len(p.prior) - 1; i >= 0; i-- {
		st := p.prior[i]
		if st.existed {
			s.srcs[st.source] = st.ivs
		} else {
			delete(s.srcs, st.source)
		}
	}
}
