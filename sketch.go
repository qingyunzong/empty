package dataeng

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// ErrIncompatibleMerge is returned by Merge when the two sketches were not
// built from identical parameters (seed, width, depth, epsilon, decay) or
// sit at different decay generations.
var ErrIncompatibleMerge = errors.New("dataeng: incompatible sketch parameters")

// ErrNegativeCount is returned by Add when a negative delta would drive the
// estimated count of an item below zero, violating the strict turnstile
// condition.
var ErrNegativeCount = errors.New("dataeng: negative update violates strict turnstile condition")

// Config holds the explicit parameters of a Sketch. Two sketches may only be
// merged when every field matches and both are at the same decay generation.
type Config struct {
	// Width is the number of counters per row.
	Width uint32
	// Depth is the number of hash rows.
	Depth uint32
	// Seed feeds every row hash so colliding layouts differ across deployments.
	Seed uint64
	// Epsilon is the relative error parameter in (0, 1). It also sizes the
	// heavy-hitter candidate set to ceil(1/Epsilon) entries.
	Epsilon float64
	// Decay is the per-generation multiplier in (0, 1] applied to every
	// counter by AdvanceGeneration.
	Decay float64
}

func (c Config) validate() error {
	if c.Width == 0 || c.Depth == 0 {
		return fmt.Errorf("dataeng: width and depth must be positive, got %dx%d", c.Width, c.Depth)
	}
	if uint64(c.Width)*uint64(c.Depth) > math.MaxInt32 {
		return fmt.Errorf("dataeng: table %dx%d exceeds maximum size", c.Width, c.Depth)
	}
	if !(c.Epsilon > 0 && c.Epsilon < 1) {
		return fmt.Errorf("dataeng: epsilon must be in (0, 1), got %v", c.Epsilon)
	}
	if !(c.Decay > 0 && c.Decay <= 1) {
		return fmt.Errorf("dataeng: decay must be in (0, 1], got %v", c.Decay)
	}
	return nil
}

// Candidate is one entry of the heavy-hitter candidate set.
type Candidate struct {
	Item     string
	Estimate float64
}

// Sketch is a Count-Min sketch with a bounded heavy-hitter candidate set.
// Memory is fixed at construction: Depth*Width counters plus at most
// ceil(1/Epsilon) candidates. A Sketch is not safe for concurrent use.
type Sketch struct {
	cfg        Config
	table      [][]float64
	total      float64
	generation uint64
	candidates map[string]float64
	candidateN int
}

// New builds an empty Sketch from cfg.
func New(cfg Config) (*Sketch, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	table := make([][]float64, cfg.Depth)
	for i := range table {
		table[i] = make([]float64, cfg.Width)
	}
	return &Sketch{
		cfg:        cfg,
		table:      table,
		candidates: make(map[string]float64),
		candidateN: int(math.Ceil(1 / cfg.Epsilon)),
	}, nil
}

// Config returns the configuration the sketch was built with.
func (s *Sketch) Config() Config { return s.cfg }

// Generation returns the current decay generation.
func (s *Sketch) Generation() uint64 { return s.generation }

// TotalWeight returns the sum of all applied deltas (after decay).
func (s *Sketch) TotalWeight() float64 { return s.total }

// MissBound returns epsilon * TotalWeight. Every item whose true count
// exceeds this bound is guaranteed to appear in Candidates; items below it
// may be absent. The bound is derived from the configured error parameter
// and the observed total weight.
func (s *Sketch) MissBound() float64 { return s.cfg.Epsilon * s.total }

// Add applies delta to item's estimated count. Negative deltas are only
// accepted under the strict turnstile condition: the item's estimated count
// must remain non-negative, otherwise ErrNegativeCount is returned and the
// sketch is left unchanged.
func (s *Sketch) Add(item string, delta float64) error {
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return fmt.Errorf("dataeng: delta must be finite, got %v", delta)
	}
	if delta < 0 && s.Estimate(item)+delta < 0 {
		return fmt.Errorf("%w: item %q estimate %v, delta %v",
			ErrNegativeCount, item, s.Estimate(item), delta)
	}
	for row := range s.table {
		s.table[row][s.column(item, row)] += delta
	}
	s.total += delta
	s.trackCandidate(item)
	return nil
}

// Estimate returns the estimated count of item. For non-negative streams the
// estimate never undershoots the true count and overshoots by at most
// epsilon * TotalWeight with probability depending on Depth.
func (s *Sketch) Estimate(item string) float64 {
	est := math.Inf(1)
	for row := range s.table {
		if v := s.table[row][s.column(item, row)]; v < est {
			est = v
		}
	}
	return est
}

// AdvanceGeneration multiplies every counter and the total weight by the
// configured decay factor and increments the decay generation. Sketches at
// different generations cannot be merged.
func (s *Sketch) AdvanceGeneration() {
	for row := range s.table {
		for col := range s.table[row] {
			s.table[row][col] *= s.cfg.Decay
		}
	}
	s.total *= s.cfg.Decay
	for item, est := range s.candidates {
		s.candidates[item] = est * s.cfg.Decay
	}
	s.generation++
}

// Merge folds other into s. It returns ErrIncompatibleMerge unless both
// sketches share identical Config values and the same decay generation.
func (s *Sketch) Merge(other *Sketch) error {
	if other == nil {
		return fmt.Errorf("%w: nil sketch", ErrIncompatibleMerge)
	}
	if s.cfg != other.cfg || s.generation != other.generation {
		return fmt.Errorf("%w: config %+v generation %d vs config %+v generation %d",
			ErrIncompatibleMerge, s.cfg, s.generation, other.cfg, other.generation)
	}
	for row := range s.table {
		for col := range s.table[row] {
			s.table[row][col] += other.table[row][col]
		}
	}
	s.total += other.total
	for item := range other.candidates {
		s.trackCandidate(item)
	}
	return nil
}

// Candidates returns the heavy-hitter candidate set sorted by descending
// estimate. The set holds at most ceil(1/Epsilon) entries; see MissBound for
// the false-negative guarantee.
func (s *Sketch) Candidates() []Candidate {
	out := make([]Candidate, 0, len(s.candidates))
	for item, est := range s.candidates {
		out = append(out, Candidate{Item: item, Estimate: est})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Estimate != out[j].Estimate {
			return out[i].Estimate > out[j].Estimate
		}
		return out[i].Item < out[j].Item
	})
	return out
}

// trackCandidate refreshes item's entry in the bounded candidate set,
// evicting the current minimum when the set is full.
func (s *Sketch) trackCandidate(item string) {
	est := s.Estimate(item)
	if _, ok := s.candidates[item]; ok {
		s.candidates[item] = est
		return
	}
	if len(s.candidates) < s.candidateN {
		s.candidates[item] = est
		return
	}
	var minItem string
	minEst := math.Inf(1)
	for cand, candEst := range s.candidates {
		if candEst < minEst || (candEst == minEst && cand > minItem) {
			minItem, minEst = cand, candEst
		}
	}
	if est > minEst {
		delete(s.candidates, minItem)
		s.candidates[item] = est
	}
}

// column hashes item into a column of the given row, keyed by the configured
// seed so layouts differ across deployments.
func (s *Sketch) column(item string, row int) uint32 {
	h := fnv64a(item)
	h ^= s.cfg.Seed + uint64(row)*0x9E3779B97F4A7C15
	h = splitmix64(h)
	return uint32(h % uint64(s.cfg.Width))
}

func fnv64a(s string) uint64 {
	const (
		offset = 14695981039346656037
		prime  = 1099511628211
	)
	h := uint64(offset)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime
	}
	return h
}

func splitmix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xBF58476D1CE4E5B9
	x ^= x >> 27
	x *= 0x94D049BB133111EB
	x ^= x >> 31
	return x
}
