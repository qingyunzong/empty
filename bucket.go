// Package bucket provides time-based aggregation buckets whose origin may be
// negative and may move over time.
//
// Bucket indices are defined as floor((t-origin)/width), i.e. division
// rounding toward negative infinity. All index arithmetic is done with
// math/big so that extreme timestamps and origins (including math.MinInt64
// and math.MaxInt64) never overflow.
//
// Changing the origin starts a new generation. Events recorded under older
// generations stay in those generations, so historical queries are never
// polluted by later origin changes.
package bucket

import (
	"errors"
	"fmt"
	"math/big"
)

// ErrInvalidWidth is returned when the bucket width is not positive.
var ErrInvalidWidth = errors.New("bucket: width must be positive")

// Generation holds the buckets recorded under one origin.
type Generation struct {
	origin  int64
	width   int64
	buckets map[string]int64 // decimal bucket index -> event count
	total   int64
}

// Aggregator is a sequence of generations sharing one bucket width.
type Aggregator struct {
	width int64
	gens  []*Generation
}

// New creates an Aggregator with the given positive bucket width and an
// initial origin (which may be negative).
func New(width, origin int64) (*Aggregator, error) {
	if width <= 0 {
		return nil, ErrInvalidWidth
	}
	a := &Aggregator{width: width}
	a.gens = append(a.gens, newGeneration(origin, width))
	return a, nil
}

func newGeneration(origin, width int64) *Generation {
	return &Generation{origin: origin, width: width, buckets: make(map[string]int64)}
}

// bucketIndex returns floor((t-origin)/width) with division rounding toward
// negative infinity, computed in arbitrary precision.
func bucketIndex(t, origin, width int64) *big.Int {
	num := big.NewInt(t)
	num.Sub(num, big.NewInt(origin))
	// big.Int.Div is Euclidean division: for width > 0 the quotient is
	// exactly floor(num/width).
	return num.Div(num, big.NewInt(width))
}

// ceilDiv returns ceil(num/width) for width > 0 in arbitrary precision.
func ceilDiv(num *big.Int, width int64) *big.Int {
	neg := new(big.Int).Neg(num)
	q := neg.Div(neg, big.NewInt(width)) // floor(-num/width)
	return q.Neg(q)
}

func (a *Aggregator) current() *Generation { return a.gens[len(a.gens)-1] }

// Generation returns the index of the current generation.
func (a *Aggregator) Generation() int { return len(a.gens) - 1 }

// Origin returns the origin of the given generation.
func (a *Aggregator) Origin(gen int) (int64, error) {
	if gen < 0 || gen >= len(a.gens) {
		return 0, fmt.Errorf("bucket: generation %d out of range", gen)
	}
	return a.gens[gen].origin, nil
}

// SetOrigin starts a new generation with the given origin and returns its
// index. Buckets of previous generations are left untouched.
func (a *Aggregator) SetOrigin(origin int64) int {
	a.gens = append(a.gens, newGeneration(origin, a.width))
	return len(a.gens) - 1
}

// Add records one event at time t in the current generation.
func (a *Aggregator) Add(t int64) {
	g := a.current()
	key := bucketIndex(t, g.origin, g.width).String()
	g.buckets[key]++
	g.total++
}

// Total returns the number of events recorded in the current generation.
func (a *Aggregator) Total() int64 { return a.current().total }

// Count returns the number of events in the current generation whose bucket
// lies entirely within the half-open range [start, end). Buckets that only
// partially overlap the range are not counted.
func (a *Aggregator) Count(start, end int64) int64 {
	return countIn(a.current(), start, end)
}

// CountGeneration is Count applied to a specific (possibly past) generation.
func (a *Aggregator) CountGeneration(gen int, start, end int64) (int64, error) {
	if gen < 0 || gen >= len(a.gens) {
		return 0, fmt.Errorf("bucket: generation %d out of range", gen)
	}
	return countIn(a.gens[gen], start, end), nil
}

// countIn sums buckets fully contained in [start, end). A bucket with index
// i spans [origin+i*width, origin+(i+1)*width); it is contained iff
// i >= ceil((start-origin)/width) and i <= floor((end-origin)/width)-1.
func countIn(g *Generation, start, end int64) int64 {
	width := big.NewInt(g.width)

	loNum := big.NewInt(start)
	loNum.Sub(loNum, big.NewInt(g.origin))
	lo := ceilDiv(loNum, g.width)

	hiNum := big.NewInt(end)
	hiNum.Sub(hiNum, big.NewInt(g.origin))
	hi := hiNum.Div(hiNum, width) // floor
	hi.Sub(hi, big.NewInt(1))

	var sum int64
	for key, n := range g.buckets {
		idx, ok := new(big.Int).SetString(key, 10)
		if !ok {
			continue
		}
		if idx.Cmp(lo) >= 0 && idx.Cmp(hi) <= 0 {
			sum += n
		}
	}
	return sum
}
