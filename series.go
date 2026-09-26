// Package counterrate converts cumulative counter telemetry into rates.
//
// Semantics:
//   - Samples may arrive out of order; they are sorted by timestamp at query time.
//   - A sample with Restart=true opens a new epoch (segment). The counter is
//     expected to be monotonic only within a segment.
//   - A value decrease without a restart marker is an unmarked reset: the
//     negative delta is never counted (no fabricated negative rate) and the
//     enclosing window is flagged Uncertain.
//   - Duplicate timestamps with different values are resolved by a
//     ConflictPolicy; identical duplicates are dropped silently.
//   - Window boundaries are linearly interpolated between neighbouring
//     samples of the same segment; outside the data range values are
//     clamped to the nearest sample (never extrapolated).
package counterrate

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// Sample is one cumulative counter observation.
type Sample struct {
	Ts      time.Time
	Value   float64
	Restart bool // true marks the first sample of a new epoch
}

// ConflictPolicy decides how duplicate timestamps with different values merge.
type ConflictPolicy int

const (
	// ConflictLastWins keeps the sample ingested last (default).
	ConflictLastWins ConflictPolicy = iota
	// ConflictFirstWins keeps the sample ingested first.
	ConflictFirstWins
	// ConflictMaxWins keeps the largest value (counter-friendly).
	ConflictMaxWins
	// ConflictError rejects the batch when values differ.
	ConflictError
)

// ErrConflict is returned by Resolve under ConflictError.
var ErrConflict = errors.New("counterrate: conflicting values for identical timestamp")

// Series accumulates samples for one counter.
type Series struct {
	policy ConflictPolicy
	// ingestSeq preserves ingestion order so LastWins/FirstWins are stable.
	ingestSeq int
	samples   []stamped
	// Conflicts counts timestamp collisions whose values differed.
	Conflicts int
}

type stamped struct {
	Sample
	seq int
}

// NewSeries creates an empty series using the given conflict policy.
func NewSeries(policy ConflictPolicy) *Series {
	return &Series{policy: policy}
}

// Add ingests samples in any order.
func (s *Series) Add(samples ...Sample) {
	for _, sm := range samples {
		s.samples = append(s.samples, stamped{Sample: sm, seq: s.ingestSeq})
		s.ingestSeq++
	}
}

// segment is a run of samples within one epoch, sorted by timestamp.
type segment []Sample

// Resolve sorts samples, merges duplicate timestamps per the conflict
// policy, and splits the stream into segments at restart markers.
func (s *Series) Resolve() ([]segment, error) {
	sorted := make([]stamped, len(s.samples))
	copy(sorted, s.samples)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Ts.Before(sorted[j].Ts)
	})

	merged := make([]Sample, 0, len(sorted))
	for i := 0; i < len(sorted); {
		j := i + 1
		for j < len(sorted) && sorted[j].Ts.Equal(sorted[i].Ts) {
			j++
		}
		group := sorted[i:j]
		// A restart marker on any duplicate marks the segment head.
		restart := false
		same := true
		for _, g := range group[1:] {
			if g.Value != group[0].Value {
				same = false
			}
			if g.Restart {
				restart = true
			}
		}
		if group[0].Restart {
			restart = true
		}
		pick := group[0]
		if !same {
			s.Conflicts++
			switch s.policy {
			case ConflictError:
				return nil, fmt.Errorf("%w: ts=%s (%d values)", ErrConflict, group[0].Ts.Format(time.RFC3339Nano), len(group))
			case ConflictLastWins:
				pick = group[len(group)-1]
			case ConflictMaxWins:
				for _, g := range group[1:] {
					if g.Value > pick.Value {
						pick = g
					}
				}
			case ConflictFirstWins:
			}
		}
		merged = append(merged, Sample{Ts: pick.Ts, Value: pick.Value, Restart: restart})
		i = j
	}

	var segs []segment
	for _, sm := range merged {
		if sm.Restart || len(segs) == 0 {
			segs = append(segs, segment{sm})
			continue
		}
		segs[len(segs)-1] = append(segs[len(segs)-1], sm)
	}
	return segs, nil
}
