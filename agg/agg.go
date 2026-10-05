// Package agg implements a time-bucketed event aggregator.
//
// Semantics:
//   - The bucket origin may be any int64, including negative values.
//   - The bucket index of a timestamp t is floor((t - origin) / width),
//     where floor rounds toward negative infinity (not truncation).
//   - A sliding range query [start, end) counts only events whose bucket
//     lies completely inside the range; events in edge buckets that
//     straddle the range boundary are excluded.
//   - Changing the origin starts a new generation. Previous generations
//     are immutable and remain queryable, so re-origining never pollutes
//     old queries.
//
// All index and span arithmetic uses math/big so that extreme values
// (math.MinInt64 / math.MaxInt64 timestamps and origins) are exact.
package agg

import (
	"errors"
	"math/big"
)

// ErrInvalidWidth is returned when a non-positive bucket width is supplied.
var ErrInvalidWidth = errors.New("agg: bucket width must be positive")

// ErrNoGeneration is returned when querying a generation that does not exist.
var ErrNoGeneration = errors.New("agg: generation does not exist")

// generation is one immutable epoch of the aggregator: a fixed origin plus
// the events recorded while that origin was in effect.
type generation struct {
	origin  int64
	buckets map[string]int64 // bucket index (decimal) -> event count
}

// Aggregator buckets events by time. It is not safe for concurrent use.
type Aggregator struct {
	width int64
	gens  []generation
}

// New creates an Aggregator with the given bucket width and initial origin.
// The origin may be negative.
func New(width, origin int64) (*Aggregator, error) {
	if width <= 0 {
		return nil, ErrInvalidWidth
	}
	return &Aggregator{
		width: width,
		gens:  []generation{{origin: origin, buckets: make(map[string]int64)}},
	}, nil
}

// SetOrigin switches to a new origin, starting a new generation. Events
// added afterwards belong to the new generation; existing generations are
// left untouched. It returns the index of the new generation.
func (a *Aggregator) SetOrigin(origin int64) int {
	a.gens = append(a.gens, generation{origin: origin, buckets: make(map[string]int64)})
	return len(a.gens) - 1
}

// Generations reports how many generations exist.
func (a *Aggregator) Generations() int { return len(a.gens) }

// Origin returns the origin of the given generation.
func (a *Aggregator) Origin(gen int) (int64, error) {
	if gen < 0 || gen >= len(a.gens) {
		return 0, ErrNoGeneration
	}
	return a.gens[gen].origin, nil
}

// bucketIndex returns floor((t - origin) / width) with the floor rounding
// toward negative infinity. The subtraction is done in big.Int so extreme
// timestamps and origins cannot overflow.
func bucketIndex(t, origin, width int64) *big.Int {
	num := new(big.Int).Sub(big.NewInt(t), big.NewInt(origin))
	den := big.NewInt(width)
	q := new(big.Int).Quo(num, den) // truncated toward zero
	r := new(big.Int).Rem(num, den)
	// Floor adjustment: when the division is inexact and the signs of the
	// remainder and divisor differ, the truncated quotient is one too high.
	if r.Sign() != 0 && r.Sign() != den.Sign() {
		q.Sub(q, big.NewInt(1))
	}
	return q
}

// BucketIndex returns the bucket index of t in the given generation,
// floor((t - origin) / width) rounded toward negative infinity.
func (a *Aggregator) BucketIndex(gen int, t int64) (*big.Int, error) {
	if gen < 0 || gen >= len(a.gens) {
		return nil, ErrNoGeneration
	}
	return bucketIndex(t, a.gens[gen].origin, a.width), nil
}

// Add records one event at time t in the current (latest) generation.
func (a *Aggregator) Add(t int64) {
	a.AddTo(len(a.gens)-1, t)
}

// AddTo records one event at time t in a specific generation. It exists so
// tests and backfills can target older generations explicitly.
func (a *Aggregator) AddTo(gen int, t int64) error {
	if gen < 0 || gen >= len(a.gens) {
		return ErrNoGeneration
	}
	g := &a.gens[gen]
	idx := bucketIndex(t, g.origin, a.width).String()
	g.buckets[idx]++
	return nil
}

// bucketSpan returns the half-open span [lo, hi) covered by bucket idx of
// the given origin, computed in big.Int to avoid overflow at extremes.
func bucketSpan(origin, width int64, idx *big.Int) (lo, hi *big.Int) {
	lo = new(big.Int).Mul(new(big.Int).Set(idx), big.NewInt(width))
	lo.Add(lo, big.NewInt(origin))
	hi = new(big.Int).Add(lo, big.NewInt(width))
	return lo, hi
}

// Query counts events in generation gen whose bucket lies completely inside
// the half-open sliding range [start, end). Buckets that merely overlap the
// range boundaries contribute nothing.
func (a *Aggregator) Query(gen int, start, end int64) (int64, error) {
	if gen < 0 || gen >= len(a.gens) {
		return 0, ErrNoGeneration
	}
	g := &a.gens[gen]
	bigStart := big.NewInt(start)
	bigEnd := big.NewInt(end)
	var total int64
	for key, count := range g.buckets {
		idx, _ := new(big.Int).SetString(key, 10)
		lo, hi := bucketSpan(g.origin, a.width, idx)
		if lo.Cmp(bigStart) >= 0 && hi.Cmp(bigEnd) <= 0 {
			total += count
		}
	}
	return total, nil
}

// QueryCurrent counts fully-contained events of the current generation.
func (a *Aggregator) QueryCurrent(start, end int64) (int64, error) {
	return a.Query(len(a.gens)-1, start, end)
}
