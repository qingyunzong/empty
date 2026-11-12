package dataeng

import (
	"fmt"
	"math/big"
	"sort"
)

// Rational is a non-negative rational number expressed as decimal big integer
// numerator and a positive denominator. Valid probability inputs must be
// reduced fractions; zero must be written as 0/1.
type Rational struct {
	Num string
	Den string
}

// ProbabilityStatus describes the state of the output probability vector.
type ProbabilityStatus int

const (
	// ProbabilityMissing means the input probability field was absent, so no
	// mass or distribution is produced.
	ProbabilityMissing ProbabilityStatus = iota
	// ProbabilityDefined means retained mass is positive and the normalized
	// target distribution is available.
	ProbabilityDefined
	// ProbabilityUndefined means every input tuple was dropped, so retained
	// mass is zero and no distribution can be normalized.
	ProbabilityUndefined
)

// VectorResult is the output of ConvertVector.
type VectorResult struct {
	Status ProbabilityStatus
	// Retained and Discarded partition the input mass. They hold zero-value
	// Rationals when Status is ProbabilityMissing.
	Retained  Rational
	Discarded Rational
	// Probabilities is indexed by target rank. It is populated only when
	// Status is ProbabilityDefined; it is nil for missing or undefined input.
	Probabilities []Rational
}

func isCanonicalDecimal(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	if len(s) > 1 && s[0] == '0' {
		return false
	}
	return true
}

// parseRational enforces decimal big integers, non-negative numerator,
// positive denominator, the 0/1 zero convention, and the reduced form.
func parseRational(r Rational) (*big.Rat, error) {
	if !isCanonicalDecimal(r.Num) || !isCanonicalDecimal(r.Den) {
		return nil, fmt.Errorf("%w: %q/%q is not a decimal integer pair", ErrInvalidRational, r.Num, r.Den)
	}
	num, _ := new(big.Int).SetString(r.Num, 10)
	den, _ := new(big.Int).SetString(r.Den, 10)
	if den.Sign() <= 0 {
		return nil, fmt.Errorf("%w: denominator %s must be positive", ErrInvalidRational, r.Den)
	}
	if num.Sign() < 0 {
		return nil, fmt.Errorf("%w: numerator %s must be non-negative", ErrInvalidRational, r.Num)
	}
	if num.Sign() == 0 && den.Cmp(big.NewInt(1)) != 0 {
		return nil, fmt.Errorf("%w: zero must be represented as 0/1, got %s/%s", ErrInvalidRational, r.Num, r.Den)
	}
	if num.Sign() > 0 {
		gcd := new(big.Int).GCD(nil, nil, new(big.Int).Set(num), new(big.Int).Set(den))
		if gcd.Cmp(big.NewInt(1)) != 0 {
			return nil, fmt.Errorf("%w: fraction %s/%s is not reduced", ErrInvalidRational, r.Num, r.Den)
		}
	}
	return new(big.Rat).SetFrac(num, den), nil
}

func ratToRational(r *big.Rat) Rational {
	return Rational{Num: r.Num().String(), Den: r.Denom().String()}
}

func (t *Transform) checkBudget(budget int64) error {
	if budget <= 0 {
		return fmt.Errorf("%w: budget %d must be a positive integer", ErrInvalidBudget, budget)
	}
	limit := big.NewInt(budget)
	if sourceCount := t.SourceCount(); sourceCount.Cmp(limit) > 0 {
		return fmt.Errorf("%w: source combination count %s exceeds budget %d", ErrBudgetExceeded, sourceCount.String(), budget)
	}
	if targetCount := t.TargetCount(); targetCount.Cmp(limit) > 0 {
		return fmt.Errorf("%w: target combination count %s exceeds budget %d", ErrBudgetExceeded, targetCount.String(), budget)
	}
	return nil
}

// nextTuple advances a non-decreasing tuple in lexicographic order, returning
// false when the space is exhausted. It avoids big.Int work per entry.
func nextTuple(tuple []int, alleles int) bool {
	for i := len(tuple) - 1; i >= 0; i-- {
		if tuple[i] < alleles-1 {
			value := tuple[i] + 1
			for j := i; j < len(tuple); j++ {
				tuple[j] = value
			}
			return true
		}
	}
	return false
}

// ConvertVector projects an optional complete probability vector. A nil input
// means the probability field is absent: the result is missing and no mass is
// fabricated. budget is the caller's positive integer ceiling for both the
// source and target combination counts; an over-budget request is rejected
// before any probability allocation or input traversal.
func (t *Transform) ConvertVector(probabilities []Rational, budget int64) (*VectorResult, error) {
	if err := t.checkBudget(budget); err != nil {
		return nil, err
	}
	if probabilities == nil {
		return &VectorResult{Status: ProbabilityMissing}, nil
	}

	sourceCount := t.SourceCount()
	if !sourceCount.IsInt64() {
		return nil, fmt.Errorf("%w: source combination count %s is not addressable", ErrBudgetExceeded, sourceCount.String())
	}
	if int64(len(probabilities)) != sourceCount.Int64() {
		return nil, fmt.Errorf("%w: got %d entries, need %s", ErrLengthMismatch, len(probabilities), sourceCount.String())
	}

	targetCount := t.TargetCount()
	if !targetCount.IsInt64() {
		return nil, fmt.Errorf("%w: target combination count %s is not addressable", ErrBudgetExceeded, targetCount.String())
	}
	targetBuckets := make([]*big.Rat, targetCount.Int64())
	for i := range targetBuckets {
		targetBuckets[i] = new(big.Rat)
	}

	retained := new(big.Rat)
	discarded := new(big.Rat)
	total := new(big.Rat)
	tuple := make([]int, t.Ploidy)
	for sourceRank := 0; sourceRank < len(probabilities); sourceRank++ {
		prob, err := parseRational(probabilities[sourceRank])
		if err != nil {
			return nil, fmt.Errorf("%w at source rank %d", err, sourceRank)
		}
		total.Add(total, prob)

		mapped := make([]int, 0, t.Ploidy)
		for _, allele := range tuple {
			target, ok := t.MapAllele(allele)
			if !ok {
				mapped = nil
				break
			}
			mapped = append(mapped, target)
		}
		if mapped == nil {
			discarded.Add(discarded, prob)
		} else {
			sort.Ints(mapped)
			targetRank, err := Rank(mapped, t.Ploidy)
			if err != nil {
				return nil, err
			}
			targetBuckets[targetRank.Int64()].Add(targetBuckets[targetRank.Int64()], prob)
			retained.Add(retained, prob)
		}
		nextTuple(tuple, t.SourceAlleles)
	}

	if total.Cmp(big.NewRat(1, 1)) != 0 {
		return nil, fmt.Errorf("%w: probabilities sum to %s, want 1/1", ErrInvalidRational, total.String())
	}

	result := &VectorResult{
		Retained:  ratToRational(retained),
		Discarded: ratToRational(discarded),
	}
	if retained.Sign() == 0 {
		result.Status = ProbabilityUndefined
		return result, nil
	}

	result.Status = ProbabilityDefined
	result.Probabilities = make([]Rational, len(targetBuckets))
	for i, bucket := range targetBuckets {
		normalized := new(big.Rat).Quo(bucket, retained)
		result.Probabilities[i] = ratToRational(normalized)
	}
	return result, nil
}
