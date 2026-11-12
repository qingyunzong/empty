package dataeng

import (
	"fmt"
	"math/big"
)

const (
	minPloidy  = 1
	maxPloidy  = 16
	minAlleles = 1
	maxAlleles = 64
)

func validatePloidy(ploidy int) error {
	if ploidy < minPloidy || ploidy > maxPloidy {
		return fmt.Errorf("%w: ploidy %d is outside [%d,%d]", ErrInvalidPloidy, ploidy, minPloidy, maxPloidy)
	}
	return nil
}

func validateAlleleCount(alleles int) error {
	if alleles < minAlleles || alleles > maxAlleles {
		return fmt.Errorf("%w: allele count %d is outside [%d,%d]", ErrInvalidAlleleCount, alleles, minAlleles, maxAlleles)
	}
	return nil
}

// binomial returns C(n, k) as an arbitrary precision integer. It returns 0
// when n < k and never uses floating point arithmetic.
func binomial(n, k int) *big.Int {
	result := new(big.Int)
	if n < 0 || k < 0 || k > n {
		return result
	}
	if k > n-k {
		k = n - k
	}
	result.SetInt64(1)
	for i := 0; i < k; i++ {
		result.Mul(result, big.NewInt(int64(n-i)))
		result.Div(result, big.NewInt(int64(i+1)))
	}
	return result
}

// TupleCount returns the number of non-decreasing tuples of length ploidy
// drawn from alleles indices, i.e. C(alleles+ploidy-1, ploidy).
func TupleCount(alleles, ploidy int) (*big.Int, error) {
	if err := validateAlleleCount(alleles); err != nil {
		return nil, err
	}
	if err := validatePloidy(ploidy); err != nil {
		return nil, err
	}
	return binomial(alleles+ploidy-1, ploidy), nil
}

// Rank computes the zero-based rank of a non-decreasing allele tuple using
// sum(i=1..P) C(a_i+i-1, i). The tuple must have length ploidy, contain only
// non-negative indices, and be non-decreasing. Rank is exact for arbitrarily
// large indices and never enumerates the combination space.
func Rank(tuple []int, ploidy int) (*big.Int, error) {
	if err := validatePloidy(ploidy); err != nil {
		return nil, err
	}
	if len(tuple) != ploidy {
		return nil, fmt.Errorf("%w: tuple length %d does not match ploidy %d", ErrInvalidTuple, len(tuple), ploidy)
	}
	rank := new(big.Int)
	previous := 0
	for i, allele := range tuple {
		if allele < 0 {
			return nil, fmt.Errorf("%w: negative allele index %d at position %d", ErrInvalidTuple, allele, i)
		}
		if i > 0 && allele < previous {
			return nil, fmt.Errorf("%w: tuple is not non-decreasing at position %d", ErrInvalidTuple, i)
		}
		previous = allele
		// Position i is zero-based; the formula term is C(a+i, i+1).
		rank.Add(rank, binomial(allele+i, i+1))
	}
	return rank, nil
}

// Unrank returns the non-decreasing tuple at the given zero-based rank among
// alleles indices. It performs an exact combinatorial-number-system search
// with big.Int comparisons, so it works beyond 2^53 without floating point
// arithmetic and without enumerating tuples.
func Unrank(alleles, ploidy int, rank *big.Int) ([]int, error) {
	if err := validateAlleleCount(alleles); err != nil {
		return nil, err
	}
	if err := validatePloidy(ploidy); err != nil {
		return nil, err
	}
	if rank == nil || rank.Sign() < 0 {
		return nil, fmt.Errorf("%w: rank must be a non-negative big.Int", ErrInvalidIndex)
	}
	total := binomial(alleles+ploidy-1, ploidy)
	if rank.Cmp(total) >= 0 {
		return nil, fmt.Errorf("%w: rank %s is outside [0,%s)", ErrInvalidIndex, rank.String(), total.String())
	}

	tuple := make([]int, ploidy)
	remaining := new(big.Int).Set(rank)
	upper := alleles - 1
	for i := ploidy - 1; i >= 0; i-- {
		// Find the largest a <= upper with C(a+i, i+1) <= remaining.
		lo, hi := 0, upper
		for lo < hi {
			mid := lo + (hi-lo+1)/2
			if binomial(mid+i, i+1).Cmp(remaining) <= 0 {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		allele := lo
		tuple[i] = allele
		remaining.Sub(remaining, binomial(allele+i, i+1))
		upper = allele
	}
	return tuple, nil
}
