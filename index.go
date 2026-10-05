package trendlib

import (
	"fmt"
	"math/big"
	"sort"
)

// Correction replaces all samples in the half-open business-time range
// [Start, End) with Samples, effective from the version at which its batch
// is committed. Correction sample times should lie inside [Start, End).
type Correction struct {
	Start   int64    `json:"start"`
	End     int64    `json:"end"`
	Samples []Sample `json:"samples"`
}

// Batch is a set of corrections committed atomically as one version.
// Corrections apply in order; later ones win where ranges overlap.
type Batch struct {
	Corrections []Correction `json:"corrections"`
}

// Index maintains regression statistics by business time and commit
// version. Every committed batch produces a new immutable version;
// historical versions never see future corrections.
type Index struct {
	versions []*versionData
}

// NewIndex builds an index whose version 0 holds the base samples.
func NewIndex(base []Sample) *Index {
	return &Index{versions: []*versionData{newVersionData(sortedSamples(base))}}
}

func sortedSamples(s []Sample) []Sample {
	out := make([]Sample, len(s))
	copy(out, s)
	sort.SliceStable(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

// Version returns the latest committed version (0 = base samples only).
func (ix *Index) Version() int { return len(ix.versions) - 1 }

// Publish commits a batch and returns the new version number.
func (ix *Index) Publish(b Batch) int {
	samples := ix.versions[len(ix.versions)-1].samples
	for _, c := range b.Corrections {
		if c.Start >= c.End {
			continue
		}
		samples = applyCorrection(samples, c)
	}
	ix.versions = append(ix.versions, newVersionData(samples))
	return ix.Version()
}

func applyCorrection(samples []Sample, c Correction) []Sample {
	out := make([]Sample, 0, len(samples)+len(c.Samples))
	for _, s := range samples {
		if s.T < c.Start || s.T >= c.End {
			out = append(out, s)
		}
	}
	out = append(out, c.Samples...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

// Query returns the exact regression slope and residual sum of squares over
// the half-open range [lo, hi) as of the given commit version. Samples at
// lo are included, samples at hi are excluded, and fractional points
// interpolated at both range edges participate in the statistics. The slope
// is nil when the x variance is zero.
func (ix *Index) Query(lo, hi int64, version int) (slope, rss *big.Rat, err error) {
	if version < 0 || version > ix.Version() {
		return nil, nil, fmt.Errorf("trendlib: version %d out of range [0, %d]", version, ix.Version())
	}
	slope, rss = ix.versions[version].query(lo, hi)
	return slope, rss, nil
}
