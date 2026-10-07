// Package recipe solves a two-scenario integer recipe (feed-mix) problem
// with exact rational arithmetic. All comparisons are performed by
// cross-multiplication on big integers, so results are exact ratios.
package recipe

import (
	"fmt"
	"math/big"
	"strings"
)

// cmpRat compares a and b by cross-multiplication:
// a = an/ad, b = bn/bd with positive denominators, so
// a <=> b  iff  an*bd <=> bn*ad.
// It returns -1, 0 or +1. No floating point is ever involved.
func cmpRat(a, b *big.Rat) int {
	left := new(big.Int).Mul(a.Num(), b.Denom())
	right := new(big.Int).Mul(b.Num(), a.Denom())
	return left.Cmp(right)
}

func ltRat(a, b *big.Rat) bool { return cmpRat(a, b) < 0 }
func leRat(a, b *big.Rat) bool { return cmpRat(a, b) <= 0 }
func gtRat(a, b *big.Rat) bool { return cmpRat(a, b) > 0 }
func geRat(a, b *big.Rat) bool { return cmpRat(a, b) >= 0 }

// rat parses an exact ratio such as "3", "2/7" or "-5/4".
func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic(fmt.Sprintf("recipe: bad rational %q", s))
	}
	return r
}

func ratInt(v int64) *big.Rat { return new(big.Rat).SetInt64(v) }

func cloneRat(r *big.Rat) *big.Rat { return new(big.Rat).Set(r) }

// frac renders a rational as an exact ratio "p/q" (or "p" when integral).
func frac(r *big.Rat) string {
	if r.IsInt() {
		return r.Num().String()
	}
	return r.RatString()
}

// fracVec renders a vector of rationals as exact ratios.
func fracVec(v []*big.Rat) string {
	parts := make([]string, len(v))
	for i, r := range v {
		parts[i] = frac(r)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}
