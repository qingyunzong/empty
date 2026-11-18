package formal

import (
	"fmt"
	"math"
	"math/big"
)

// Share is an exact, non-negative rational dominant-share value. The zero
// value of Share represents zero. Shares are immutable from the caller's
// perspective: every accessor returns a copy of the underlying number.
type Share struct {
	rat *big.Rat
	inf bool
}

// ZeroShare returns the exact zero share.
func ZeroShare() Share { return Share{} }

// NewShare constructs numerator/denominator exactly.
func NewShare(numerator, denominator int64) Share {
	if denominator <= 0 {
		if numerator == 0 {
			return Share{}
		}
		return Share{inf: true}
	}
	if numerator <= 0 {
		return Share{}
	}
	return Share{rat: new(big.Rat).SetFrac64(numerator, denominator)}
}

func shareFromRat(r *big.Rat) Share {
	if r == nil || r.Sign() == 0 {
		return Share{}
	}
	return Share{rat: new(big.Rat).Set(r)}
}

// IsZero reports whether s is exactly zero.
func (s Share) IsZero() bool {
	return !s.inf && (s.rat == nil || s.rat.Sign() == 0)
}

// IsInf reports whether s represents an infinite share (an allocation on a
// zero-capacity resource).
func (s Share) IsInf() bool { return s.inf }

// Cmp compares two shares exactly. It returns -1, 0, or 1.
func (s Share) Cmp(other Share) int {
	switch {
	case s.inf && other.inf:
		return 0
	case s.inf:
		return 1
	case other.inf:
		return -1
	case s.rat == nil && other.rat == nil:
		return 0
	case s.rat == nil:
		return -other.rat.Sign()
	case other.rat == nil:
		return s.rat.Sign()
	default:
		return s.rat.Cmp(other.rat)
	}
}

// Float64 returns the closest floating-point representation. It is intended
// for presentation only; all scheduling decisions use exact comparison.
func (s Share) Float64() float64 {
	if s.inf {
		return math.Inf(1)
	}
	if s.rat == nil {
		return 0
	}
	value, _ := s.rat.Float64()
	return value
}

// Rat returns a copy of the exact rational value. Infinite shares return nil;
// zero returns a zero rational.
func (s Share) Rat() *big.Rat {
	if s.inf {
		return nil
	}
	if s.rat == nil {
		return new(big.Rat)
	}
	return new(big.Rat).Set(s.rat)
}

// Numerator returns a copy of the reduced numerator.
func (s Share) Numerator() *big.Int {
	if s.inf {
		return nil
	}
	if s.rat == nil {
		return big.NewInt(0)
	}
	return new(big.Int).Set(s.rat.Num())
}

// Denominator returns a copy of the reduced denominator.
func (s Share) Denominator() *big.Int {
	if s.inf {
		return nil
	}
	if s.rat == nil {
		return big.NewInt(1)
	}
	return new(big.Int).Set(s.rat.Denom())
}

// String renders the exact fraction, or "inf".
func (s Share) String() string {
	if s.inf {
		return "inf"
	}
	if s.rat == nil {
		return "0"
	}
	return s.rat.RatString()
}

// GoString implements fmt.GoStringer.
func (s Share) GoString() string { return fmt.Sprintf("Share(%s)", s.String()) }

func (s Share) equal(other Share) bool { return s.Cmp(other) == 0 }

// DominantShare returns the unweighted dominant share:
//
//	max_r used[r] / capacity[r]
//
// Both vectors are treated as zero for missing entries. A positive usage on a
// zero-capacity resource produces an infinite share.
func DominantShare(used, capacity Vector) Share {
	_, share := dominantResource(used, capacity, 1)
	return share
}

// WeightedDominantShare returns
//
//	max_r used[r] / (capacity[r] * weight)
//
// and is the quantity used by weighted DRF. Non-positive weights are treated
// as one.
func WeightedDominantShare(used, capacity Vector, weight int64) Share {
	_, share := dominantResource(used, capacity, weight)
	return share
}

// DominantResource returns the resource producing the dominant share. Ties are
// broken lexicographically. It returns an empty name when all usage is zero.
func DominantResource(used, capacity Vector) (string, Share) {
	return dominantResource(used, capacity, 1)
}

// WeightedDominantResource is DominantResource with a DRF weight.
func WeightedDominantResource(used, capacity Vector, weight int64) (string, Share) {
	return dominantResource(used, capacity, weight)
}

func dominantResource(used, capacity Vector, factors ...int64) (string, Share) {
	// Capacity defines the meaningful dimensions. Usage on an unknown
	// dimension is still considered, with zero capacity, so accidental
	// overcommit is visible rather than silently ignored.
	names := make(map[string]struct{}, len(capacity)+len(used))
	for name := range capacity {
		names[name] = struct{}{}
	}
	for name := range used {
		names[name] = struct{}{}
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	sortStrings(ordered)

	weight := big.NewInt(1)
	for _, factor := range factors {
		if factor > 0 {
			weight.Mul(weight, big.NewInt(factor))
		}
	}

	bestName := ""
	var best *big.Rat
	bestInf := false
	for _, name := range ordered {
		amount := used[name]
		if amount <= 0 {
			continue
		}
		capacityAmount := capacity[name]
		if capacityAmount <= 0 {
			if !bestInf {
				bestName, bestInf, best = name, true, nil
			}
			continue
		}
		if bestInf {
			continue
		}
		denominator := new(big.Int).Mul(big.NewInt(capacityAmount), weight)
		candidate := new(big.Rat).SetFrac(big.NewInt(amount), denominator)
		if best == nil || candidate.Cmp(best) > 0 {
			bestName, best = name, candidate
		}
	}
	if bestInf {
		return bestName, Share{inf: true}
	}
	if best == nil {
		return "", Share{}
	}
	return bestName, shareFromRat(best)
}

func sortStrings(values []string) {
	// Small local insertion sort keeps the hot path allocation-free.
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
