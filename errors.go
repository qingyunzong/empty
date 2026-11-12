package dataeng

import "errors"

// Sentinel errors returned by the package. Callers can use errors.Is to
// detect the failure class regardless of the wrapped detail message.
var (
	// ErrInvalidPloidy means the ploidy is outside the supported 1..16 range.
	ErrInvalidPloidy = errors.New("dataeng: invalid ploidy")
	// ErrInvalidAlleleCount means an allele count is outside 1..64.
	ErrInvalidAlleleCount = errors.New("dataeng: invalid allele count")
	// ErrInvalidMapping means the source-to-target mapping is not closed.
	ErrInvalidMapping = errors.New("dataeng: mapping is not closed")
	// ErrInvalidTuple means a genotype tuple has the wrong length, a negative
	// allele, or is not non-decreasing.
	ErrInvalidTuple = errors.New("dataeng: invalid genotype tuple")
	// ErrInvalidIndex means a rank is negative or outside the combination space.
	ErrInvalidIndex = errors.New("dataeng: invalid rank index")
	// ErrInvalidRational means a probability entry is not a reduced
	// non-negative rational with a positive denominator.
	ErrInvalidRational = errors.New("dataeng: invalid rational probability")
	// ErrInvalidGT means a GT string cannot be parsed or references an allele
	// outside the source range.
	ErrInvalidGT = errors.New("dataeng: invalid GT string")
	// ErrLengthMismatch means the probability vector does not have one entry
	// per source genotype tuple.
	ErrLengthMismatch = errors.New("dataeng: probability vector length mismatch")
	// ErrBudgetExceeded means the source or target combination space exceeds
	// the caller-supplied positive integer budget.
	ErrBudgetExceeded = errors.New("dataeng: combination budget exceeded")
	// ErrInvalidBudget means the supplied budget is not a positive integer.
	ErrInvalidBudget = errors.New("dataeng: budget must be a positive integer")
)
