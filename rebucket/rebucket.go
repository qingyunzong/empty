// Package rebucket redistributes mass from non-overlapping half-open
// rational-interval buckets onto a new set of target boundaries.
//
// Each source bucket [Left, Right) carries a non-negative mass that is
// assumed to be spread uniformly along its length, so a target bucket
// receives exactly the proportional share density*overlap of every source
// bucket it intersects. Cross-bucket mass is split by true overlap length;
// it is never dumped wholesale into whichever bucket holds the midpoint.
//
// All arithmetic uses math/big.Rat: no floating point is involved anywhere,
// and every reported mass is a reduced fraction. Negative endpoints and
// gaps between source buckets are allowed.
package rebucket

import (
	"fmt"
	"math/big"
	"sort"
)

// Bucket is a half-open interval [Left, Right) whose Mass is distributed
// uniformly along its length. Primary inputs are built with NewBucket and
// carry non-negative integer masses; results of a previous Rebucket call
// (via Result.Buckets) carry rational masses and are equally valid input,
// which enables chained re-bucketing.
type Bucket struct {
	Left  *big.Rat
	Right *big.Rat
	Mass  *big.Rat
}

// NewBucket returns a Bucket over [left, right) with a non-negative
// integer mass. The arguments are copied.
func NewBucket(left, right *big.Rat, mass int64) Bucket {
	return Bucket{
		Left:  new(big.Rat).Set(left),
		Right: new(big.Rat).Set(right),
		Mass:  new(big.Rat).SetInt64(mass),
	}
}

// Result holds the outcome of a Rebucket call. Masses[i] is the exact
// reduced mass landing in the half-open target bucket
// [bounds[i], bounds[i+1]).
type Result struct {
	Masses []*big.Rat
	// LeftOverflow is the mass lying strictly left of the first boundary.
	LeftOverflow *big.Rat
	// RightOverflow is the mass lying at or right of the last boundary.
	RightOverflow *big.Rat
}

// Total returns LeftOverflow + sum(Masses) + RightOverflow. For valid
// input it always equals the sum of the source bucket masses.
func (r *Result) Total() *big.Rat {
	total := new(big.Rat).Set(r.LeftOverflow)
	for _, m := range r.Masses {
		total.Add(total, m)
	}
	return total.Add(total, r.RightOverflow)
}

// Buckets converts the result back into source buckets over the same
// target boundaries, so the output of one Rebucket call can feed the
// next. Overflow mass is not representable as buckets and is dropped;
// extend the boundaries first if it must be kept.
func (r *Result) Buckets(bounds []*big.Rat) []Bucket {
	out := make([]Bucket, len(r.Masses))
	for i, m := range r.Masses {
		out[i] = Bucket{
			Left:  new(big.Rat).Set(bounds[i]),
			Right: new(big.Rat).Set(bounds[i+1]),
			Mass:  new(big.Rat).Set(m),
		}
	}
	return out
}

// Rebucket redistributes the mass of old onto the half-open target
// buckets implied by bounds.
//
// bounds must contain at least two strictly increasing values. Source
// buckets must be non-overlapping (adjacency and gaps are fine), have
// Left < Right (zero-width buckets are rejected) and non-negative mass.
// The inputs are not modified.
func Rebucket(old []Bucket, bounds []*big.Rat) (*Result, error) {
	if err := validateBounds(bounds); err != nil {
		return nil, err
	}
	src, err := validateBuckets(old)
	if err != nil {
		return nil, err
	}

	n := len(bounds) - 1
	res := &Result{
		Masses:        make([]*big.Rat, n),
		LeftOverflow:  new(big.Rat),
		RightOverflow: new(big.Rat),
	}
	for i := range res.Masses {
		res.Masses[i] = new(big.Rat)
	}

	first, last := bounds[0], bounds[n]
	for _, b := range src {
		width := new(big.Rat).Sub(b.Right, b.Left)
		density := new(big.Rat).Quo(b.Mass, width)

		// Mass left of the first boundary: overlap with (-inf, first).
		if ov := new(big.Rat).Sub(minRat(b.Right, first), b.Left); ov.Sign() > 0 {
			res.LeftOverflow.Add(res.LeftOverflow, ov.Mul(ov, density))
		}
		// Mass right of the last boundary: overlap with [last, +inf).
		if ov := new(big.Rat).Sub(b.Right, maxRat(b.Left, last)); ov.Sign() > 0 {
			res.RightOverflow.Add(res.RightOverflow, ov.Mul(ov, density))
		}
		// Mass inside each target bucket, proportional to overlap length.
		for i := 0; i < n; i++ {
			lo := maxRat(b.Left, bounds[i])
			hi := minRat(b.Right, bounds[i+1])
			if hi.Cmp(lo) <= 0 {
				continue
			}
			ov := new(big.Rat).Sub(hi, lo)
			res.Masses[i].Add(res.Masses[i], ov.Mul(ov, density))
		}
	}
	return res, nil
}

func validateBounds(bounds []*big.Rat) error {
	if len(bounds) < 2 {
		return fmt.Errorf("rebucket: need at least two target boundaries, got %d", len(bounds))
	}
	for i, b := range bounds {
		if b == nil {
			return fmt.Errorf("rebucket: nil target boundary at index %d", i)
		}
		if i > 0 && bounds[i-1].Cmp(b) >= 0 {
			return fmt.Errorf("rebucket: target boundaries must be strictly increasing (index %d)", i)
		}
	}
	return nil
}

func validateBuckets(old []Bucket) ([]Bucket, error) {
	src := make([]Bucket, len(old))
	for i, b := range old {
		if b.Left == nil || b.Right == nil || b.Mass == nil {
			return nil, fmt.Errorf("rebucket: bucket %d has nil field", i)
		}
		if b.Left.Cmp(b.Right) >= 0 {
			return nil, fmt.Errorf("rebucket: bucket %d has zero or negative width [%v, %v)", i, b.Left, b.Right)
		}
		if b.Mass.Sign() < 0 {
			return nil, fmt.Errorf("rebucket: bucket %d has negative mass %v", i, b.Mass)
		}
		src[i] = Bucket{
			Left:  new(big.Rat).Set(b.Left),
			Right: new(big.Rat).Set(b.Right),
			Mass:  new(big.Rat).Set(b.Mass),
		}
	}
	sort.Slice(src, func(i, j int) bool {
		if c := src[i].Left.Cmp(src[j].Left); c != 0 {
			return c < 0
		}
		return src[i].Right.Cmp(src[j].Right) < 0
	})
	for i := 1; i < len(src); i++ {
		if src[i].Left.Cmp(src[i-1].Right) < 0 {
			return nil, fmt.Errorf("rebucket: buckets %v and %v overlap",
				intervalString(src[i-1]), intervalString(src[i]))
		}
	}
	return src, nil
}

func intervalString(b Bucket) string {
	return "[" + b.Left.RatString() + ", " + b.Right.RatString() + ")"
}

func minRat(a, b *big.Rat) *big.Rat {
	if a.Cmp(b) <= 0 {
		return a
	}
	return b
}

func maxRat(a, b *big.Rat) *big.Rat {
	if a.Cmp(b) >= 0 {
		return a
	}
	return b
}
