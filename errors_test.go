package dataeng

import (
	"errors"
	"math/big"
	"testing"
)

func TestValidationErrorPaths(t *testing.T) {
	if _, err := TupleCount(0, 2); !errors.Is(err, ErrInvalidAlleleCount) {
		t.Fatalf("TupleCount alleles: %v", err)
	}
	if _, err := TupleCount(65, 2); !errors.Is(err, ErrInvalidAlleleCount) {
		t.Fatalf("TupleCount alleles high: %v", err)
	}
	if _, err := TupleCount(2, 0); !errors.Is(err, ErrInvalidPloidy) {
		t.Fatalf("TupleCount ploidy: %v", err)
	}
	if _, err := Rank([]int{0}, 0); !errors.Is(err, ErrInvalidPloidy) {
		t.Fatalf("Rank ploidy: %v", err)
	}
	if _, err := Unrank(0, 2, big.NewInt(0)); !errors.Is(err, ErrInvalidAlleleCount) {
		t.Fatalf("Unrank alleles: %v", err)
	}
	if _, err := Unrank(2, 0, big.NewInt(0)); !errors.Is(err, ErrInvalidPloidy) {
		t.Fatalf("Unrank ploidy: %v", err)
	}
	if _, err := Unrank(2, 2, nil); !errors.Is(err, ErrInvalidIndex) {
		t.Fatalf("Unrank nil: %v", err)
	}

	// Mapping edge: reference retarget and mapping length mismatch.
	if _, err := NewTransform(3, 3, 2, []int{0, 1}); !errors.Is(err, ErrInvalidMapping) {
		t.Fatalf("mapping length: %v", err)
	}

	// RankSource happy path plus target unrank boundary.
	transform, err := NewTransform(3, 2, 2, []int{0, 1, Drop})
	if err != nil {
		t.Fatal(err)
	}
	rank, err := transform.RankSource([]int{0, 2})
	if err != nil {
		t.Fatal(err)
	}
	if rank.Int64() != 3 {
		t.Fatalf("RankSource([0 2]) = %s, want 3", rank.String())
	}
	if tuple, err := transform.UnrankTarget(big.NewInt(0)); err != nil || !equalInts(tuple, []int{0, 0}) {
		t.Fatalf("UnrankTarget(0) = %v, %v", tuple, err)
	}

	// Target-side budget breach: shrink the budget below the target count.
	if _, err := transform.ConvertVector(nil, 2); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("target budget: %v", err)
	}

	// Rational parser branches exercised directly.
	invalidRationals := []Rational{
		{Num: "1.5", Den: "1"},
		{Num: "1", Den: ""},
		{Num: "", Den: "1"},
		{Num: "1", Den: "+2"},
	}
	for _, rational := range invalidRationals {
		if _, err := parseRational(rational); !errors.Is(err, ErrInvalidRational) {
			t.Fatalf("parseRational(%v): %v", rational, err)
		}
	}
	if parsed, err := parseRational(Rational{Num: "0", Den: "1"}); err != nil || parsed.Sign() != 0 {
		t.Fatalf("zero rational: %v %v", parsed, err)
	}
}

func TestGTEmptyAndTrailingSeparator(t *testing.T) {
	transform, err := NewTransform(2, 2, 2, []int{0, 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, gt := range []string{"", "1/", "/1", "1|", "1/1/1", "a/b", "1/01"} {
		if _, err := transform.ConvertGT(gt); !errors.Is(err, ErrInvalidGT) {
			t.Fatalf("ConvertGT(%q): %v, want ErrInvalidGT", gt, err)
		}
	}
}
