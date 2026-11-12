package dataeng

import (
	"errors"
	"math/big"
	"testing"
)

func TestDropNormalization(t *testing.T) {
	// N=4 -> M=2: source allele 3 is dropped; alleles 1 and 2 merge.
	transform, err := NewTransform(4, 2, 2, []int{0, 1, 1, Drop})
	if err != nil {
		t.Fatal(err)
	}
	if targetCount := transform.TargetCount().Int64(); targetCount != 3 {
		t.Fatalf("target count = %d, want 3", targetCount)
	}

	// Uniform source mass 1/10. Tuples touching allele 3 are the last four
	// tuples (0,3),(1,3),(2,3),(3,3), so discarded mass is 4/10.
	result, err := transform.ConvertVector(uniformRationals(10), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != ProbabilityDefined {
		t.Fatalf("status = %d, want ProbabilityDefined", result.Status)
	}
	if result.Discarded != (Rational{Num: "2", Den: "5"}) {
		t.Fatalf("discarded = %v, want 2/5", result.Discarded)
	}
	if result.Retained != (Rational{Num: "3", Den: "5"}) {
		t.Fatalf("retained = %v, want 3/5", result.Retained)
	}

	want := map[string]Rational{
		"[0 0]": {Num: "1", Den: "6"}, // (1/10)/(3/5)
		"[0 1]": {Num: "1", Den: "3"}, // 2/10 over 3/5
		"[1 1]": {Num: "1", Den: "2"}, // 3/10 over 3/5
	}
	if len(result.Probabilities) != 3 {
		t.Fatalf("got %d target probabilities, want 3", len(result.Probabilities))
	}
	for rankIndex, probability := range result.Probabilities {
		tuple, err := transform.UnrankTarget(big.NewInt(int64(rankIndex)))
		if err != nil {
			t.Fatal(err)
		}
		if probability != want[joinTuple(tuple)] {
			t.Fatalf("tuple %v: got %v, want %v", tuple, probability, want[joinTuple(tuple)])
		}
	}
}

func TestZeroRetainedMassIsUndefined(t *testing.T) {
	// Ploidy 1: only the reference allele survives; every non-reference
	// source allele is dropped. Put zero mass on the reference and the
	// remaining mass on dropped alleles.
	transform, err := NewTransform(3, 1, 1, []int{0, Drop, Drop})
	if err != nil {
		t.Fatal(err)
	}
	probabilities := []Rational{
		{Num: "0", Den: "1"},
		{Num: "1", Den: "2"},
		{Num: "1", Den: "2"},
	}
	result, err := transform.ConvertVector(probabilities, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != ProbabilityUndefined {
		t.Fatalf("status = %d, want ProbabilityUndefined", result.Status)
	}
	if result.Retained != (Rational{Num: "0", Den: "1"}) {
		t.Fatalf("retained = %v, want 0/1", result.Retained)
	}
	if result.Discarded != (Rational{Num: "1", Den: "1"}) {
		t.Fatalf("discarded = %v, want 1/1", result.Discarded)
	}
	if result.Probabilities != nil {
		t.Fatalf("undefined result must not carry a fake zero distribution: %v", result.Probabilities)
	}
}

func TestMissingProbabilityField(t *testing.T) {
	transform, err := NewTransform(4, 2, 2, []int{0, 1, 1, Drop})
	if err != nil {
		t.Fatal(err)
	}
	result, err := transform.ConvertVector(nil, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != ProbabilityMissing {
		t.Fatalf("status = %d, want ProbabilityMissing", result.Status)
	}
	if result.Probabilities != nil || result.Retained != (Rational{}) || result.Discarded != (Rational{}) {
		t.Fatalf("missing input must not fabricate mass: %+v", result)
	}

	// An empty but non-nil slice is a length mismatch, not a missing field.
	if _, err := transform.ConvertVector([]Rational{}, 1<<20); !errors.Is(err, ErrLengthMismatch) {
		t.Fatalf("empty vector: got %v, want ErrLengthMismatch", err)
	}
}

func TestBudgetRejectedBeforeTraversal(t *testing.T) {
	// N=64, P=16 has far more than 1024 source tuples.
	identityMapping := make([]int, 64)
	for i := range identityMapping {
		identityMapping[i] = i
	}
	transform, err := NewTransform(64, 64, 16, identityMapping)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transform.ConvertVector(nil, 1024); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("budget: got %v, want ErrBudgetExceeded", err)
	}
	if _, err := transform.ConvertVector(nil, 0); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("zero budget: got %v, want ErrInvalidBudget", err)
	}
	if _, err := transform.ConvertVector(nil, -5); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("negative budget: got %v, want ErrInvalidBudget", err)
	}

	// Rank/Unrank remain exact and available regardless of any budget.
	huge := new(big.Int).Add(big.NewInt(1), new(big.Int).Lsh(big.NewInt(1), 53))
	tuple, err := transform.UnrankSource(huge)
	if err != nil {
		t.Fatal(err)
	}
	rank, err := transform.RankSource(tuple)
	if err != nil {
		t.Fatal(err)
	}
	if rank.Cmp(huge) != 0 {
		t.Fatalf("round trip = %s, want %s", rank.String(), huge.String())
	}

	last := new(big.Int).Sub(transform.SourceCount(), big.NewInt(1))
	lastTuple, err := transform.UnrankSource(last)
	if err != nil {
		t.Fatal(err)
	}
	lastRank, err := transform.RankSource(lastTuple)
	if err != nil || lastRank.Cmp(last) != 0 {
		t.Fatalf("last-rank round trip failed: %v %s", err, lastRank.String())
	}
}

func TestHugeRankBeyond2Pow53(t *testing.T) {
	rank := new(big.Int).Add(big.NewInt(1), new(big.Int).Lsh(big.NewInt(1), 53))
	tuple, err := Unrank(64, 16, rank)
	if err != nil {
		t.Fatal(err)
	}
	back, err := Rank(tuple, 16)
	if err != nil {
		t.Fatal(err)
	}
	if back.Cmp(rank) != 0 {
		t.Fatalf("round trip = %s, want %s", back.String(), rank.String())
	}
	// Every unranked tuple must be non-decreasing and within [0,64).
	previous := tuple[0]
	for _, allele := range tuple[1:] {
		if allele < previous || allele < 0 || allele >= 64 {
			t.Fatalf("invalid unranked tuple %v", tuple)
		}
		previous = allele
	}
	// 2^53+1 cannot be represented exactly as a float64 and has 16 digits,
	// proving the addressing stays in integer arithmetic.
	if rank.Cmp(new(big.Int).Lsh(big.NewInt(1), 53)) <= 0 {
		t.Fatalf("test rank %s does not exceed 2^53", rank.String())
	}
}

func TestInvalidRationalsRejected(t *testing.T) {
	transform, err := NewTransform(2, 2, 1, []int{0, 1})
	if err != nil {
		t.Fatal(err)
	}
	bad := [][]Rational{
		{{Num: "1", Den: "1"}, {Num: "0", Den: "2"}},  // zero not 0/1
		{{Num: "2", Den: "4"}, {Num: "1", Den: "2"}},  // unreduced numerator
		{{Num: "-1", Den: "1"}, {Num: "2", Den: "1"}}, // negative
		{{Num: "1", Den: "0"}, {Num: "1", Den: "1"}},  // non-positive denominator
		{{Num: "01", Den: "1"}, {Num: "1", Den: "1"}}, // leading zero
		{{Num: "1", Den: "1"}},                        // too short
	}
	for i, probabilities := range bad {
		if _, err := transform.ConvertVector(probabilities, 1<<20); err == nil {
			t.Fatalf("case %d was accepted: %v", i, probabilities)
		} else if !errors.Is(err, ErrInvalidRational) && !errors.Is(err, ErrLengthMismatch) {
			t.Fatalf("case %d: unexpected error class %v", i, err)
		}
	}

	// Reduced entries that do not total 1 are rejected.
	wrongSum := []Rational{{Num: "1", Den: "3"}, {Num: "1", Den: "3"}}
	if _, err := transform.ConvertVector(wrongSum, 1<<20); !errors.Is(err, ErrInvalidRational) {
		t.Fatalf("wrong sum: got %v", err)
	}
}

func TestConvertGTOrderSeparatorsAndMissing(t *testing.T) {
	transform, err := NewTransform(4, 3, 3, []int{0, Drop, 1, 2})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"0/1/2":   "0/./1", // drop becomes '.', order preserved
		"3|1|0":   "2|.|0", // order deliberately not non-decreasing
		"./1|2":   "./.|1", // mixed separators preserved, missing stays missing
		"0/0/0":   "0/0/0",
		"2/2/2":   "1/1/1", // merged target
		"./.":     "",      // wrong field count
		"0/1":     "",      // too few fields
		"0/1/2/3": "",      // too many fields
		"00/1/2":  "",      // leading zero
		"0/-1/2":  "",      // negative field
		"0/1/4":   "",      // out of source range
		"0//2":    "",      // empty field
		"":        "",      // empty input
	}
	for input, expected := range cases {
		got, err := transform.ConvertGT(input)
		if expected != "" {
			if err != nil {
				t.Fatalf("ConvertGT(%q): %v", input, err)
			}
			if got != expected {
				t.Fatalf("ConvertGT(%q) = %q, want %q", input, got, expected)
			}
			continue
		}
		if err == nil {
			t.Fatalf("ConvertGT(%q) = %q, expected rejection", input, got)
		}
		if !errors.Is(err, ErrInvalidGT) {
			t.Fatalf("ConvertGT(%q): %v, want ErrInvalidGT", input, err)
		}
	}

	// A lone '.' is the only valid dot spelling; '..' is not a field.
	if _, err := transform.ConvertGT("../1/2"); !errors.Is(err, ErrInvalidGT) {
		t.Fatalf("'..' field: got %v, want ErrInvalidGT", err)
	}
}
