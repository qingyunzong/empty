package trend

import (
	"fmt"
	"math/big"
	"sort"
)

// Correction replaces all samples in the half-open business-time range
// [From, To) with the given samples. Every replacement sample must lie
// inside [From, To).
type Correction struct {
	From    int64
	To      int64
	Samples []Sample
}

// Batch is a set of corrections committed atomically as one version.
// Corrections apply in order; later corrections win on overlap.
type Batch struct {
	Corrections []Correction
}

// version is an immutable snapshot: sorted samples plus integer prefix sums
// of the regression aggregates, so range queries combine prefix differences
// with fractional edge interpolation.
type version struct {
	samples        []Sample
	psx, psy       []*big.Int
	psxx, pxy, pyy []*big.Int
}

func buildVersion(samples []Sample) *version {
	n := len(samples)
	v := &version{
		samples: samples,
		psx:     make([]*big.Int, n+1),
		psy:     make([]*big.Int, n+1),
		psxx:    make([]*big.Int, n+1),
		pxy:     make([]*big.Int, n+1),
		pyy:     make([]*big.Int, n+1),
	}
	v.psx[0] = new(big.Int)
	v.psy[0] = new(big.Int)
	v.psxx[0] = new(big.Int)
	v.pxy[0] = new(big.Int)
	v.pyy[0] = new(big.Int)
	for i, s := range samples {
		x := big.NewInt(s.T)
		y := big.NewInt(s.V)
		v.psx[i+1] = new(big.Int).Add(v.psx[i], x)
		v.psy[i+1] = new(big.Int).Add(v.psy[i], y)
		v.psxx[i+1] = new(big.Int).Add(v.psxx[i], new(big.Int).Mul(x, x))
		v.pxy[i+1] = new(big.Int).Add(v.pxy[i], new(big.Int).Mul(x, y))
		v.pyy[i+1] = new(big.Int).Add(v.pyy[i], new(big.Int).Mul(y, y))
	}
	return v
}

// applyBatch applies a batch to a sorted sample slice, returning a new
// sorted slice. Duplicate timestamps keep stable insertion order.
func applyBatch(samples []Sample, b Batch) ([]Sample, error) {
	out := make([]Sample, len(samples))
	copy(out, samples)
	for ci, c := range b.Corrections {
		if c.From > c.To {
			return nil, fmt.Errorf("correction %d: from %d > to %d", ci, c.From, c.To)
		}
		repl := make([]Sample, len(c.Samples))
		copy(repl, c.Samples)
		sort.SliceStable(repl, func(i, j int) bool { return repl[i].T < repl[j].T })
		for _, s := range repl {
			if s.T < c.From || s.T >= c.To {
				return nil, fmt.Errorf("correction %d: sample at t=%d outside half-open range [%d,%d)", ci, s.T, c.From, c.To)
			}
		}
		lo := sort.Search(len(out), func(i int) bool { return out[i].T >= c.From })
		hi := sort.Search(len(out), func(i int) bool { return out[i].T >= c.To })
		next := make([]Sample, 0, len(out)-(hi-lo)+len(repl))
		next = append(next, out[:lo]...)
		next = append(next, repl...)
		next = append(next, out[hi:]...)
		out = next
	}
	return out, nil
}

// Index maintains regression statistics indexed by business time and commit
// version. Version 0 is the empty dataset; every committed batch creates a
// new version. Queries at a historical version never see later corrections.
type Index struct {
	versions []*version
}

// NewIndex returns an empty index at version 0.
func NewIndex() *Index {
	return &Index{versions: []*version{buildVersion(nil)}}
}

// Versions returns the number of versions (including the empty version 0).
func (ix *Index) Versions() int {
	return len(ix.versions)
}

// validate checks a batch against the current head without committing.
func (ix *Index) validate(b Batch) error {
	_, err := applyBatch(ix.versions[len(ix.versions)-1].samples, b)
	return err
}

// Commit applies a batch and returns the new version number.
func (ix *Index) Commit(b Batch) (int, error) {
	samples, err := applyBatch(ix.versions[len(ix.versions)-1].samples, b)
	if err != nil {
		return 0, err
	}
	ix.versions = append(ix.versions, buildVersion(samples))
	return len(ix.versions) - 1, nil
}

// Query returns exact regression statistics for the closed business-time
// range [from, to] as of the given commit version. Range edges participate
// via fractional linear interpolation when no sample sits exactly on them.
func (ix *Index) Query(ver int, from, to int64) (Stats, error) {
	if ver < 0 || ver >= len(ix.versions) {
		return Stats{}, fmt.Errorf("unknown version %d", ver)
	}
	if from > to {
		return Stats{}, fmt.Errorf("bad range: from %d > to %d", from, to)
	}
	v := ix.versions[ver]
	lo := sort.Search(len(v.samples), func(i int) bool { return v.samples[i].T >= from })
	hi := sort.Search(len(v.samples), func(i int) bool { return v.samples[i].T > to })

	agg := newAggregates()
	agg.n = int64(hi - lo)
	agg.sx.SetInt(new(big.Int).Sub(v.psx[hi], v.psx[lo]))
	agg.sy.SetInt(new(big.Int).Sub(v.psy[hi], v.psy[lo]))
	agg.sxx.SetInt(new(big.Int).Sub(v.psxx[hi], v.psxx[lo]))
	agg.sxy.SetInt(new(big.Int).Sub(v.pxy[hi], v.pxy[lo]))
	agg.syy.SetInt(new(big.Int).Sub(v.pyy[hi], v.pyy[lo]))

	if lo >= len(v.samples) || v.samples[lo].T != from {
		if p, ok := interpolate(v.samples, lo, from); ok {
			agg.add(p.x, p.y)
		}
	}
	if to > from && (hi == 0 || v.samples[hi-1].T != to) {
		if p, ok := interpolate(v.samples, hi, to); ok {
			agg.add(p.x, p.y)
		}
	}
	return agg.stats(), nil
}

// Model is the direct reference implementation: it keeps full per-version
// snapshots and computes statistics by direct rational summation over the
// selected points, including per-point residual accumulation.
type Model struct {
	versions [][]Sample
}

// NewModel returns an empty model at version 0.
func NewModel() *Model {
	return &Model{versions: [][]Sample{nil}}
}

// Commit applies a batch and returns the new version number.
func (m *Model) Commit(b Batch) (int, error) {
	samples, err := applyBatch(m.versions[len(m.versions)-1], b)
	if err != nil {
		return 0, err
	}
	m.versions = append(m.versions, samples)
	return len(m.versions) - 1, nil
}

// Versions returns the number of versions (including the empty version 0).
func (m *Model) Versions() int {
	return len(m.versions)
}

// Query recomputes statistics from scratch by direct rational summation.
func (m *Model) Query(ver int, from, to int64) (Stats, error) {
	if ver < 0 || ver >= len(m.versions) {
		return Stats{}, fmt.Errorf("unknown version %d", ver)
	}
	if from > to {
		return Stats{}, fmt.Errorf("bad range: from %d > to %d", from, to)
	}
	return directStats(selectPoints(m.versions[ver], from, to)), nil
}
