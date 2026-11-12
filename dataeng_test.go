package dataeng

import (
	"errors"
	"math/big"
	"strconv"
	"testing"
)

// pascal builds an independent int64 binomial coefficient table so the tests
// do not reuse the production binomial implementation as their oracle.
func pascal(n int) [][]int64 {
	table := make([][]int64, n+1)
	for i := range table {
		table[i] = make([]int64, i+1)
		table[i][0], table[i][i] = 1, 1
		for j := 1; j < i; j++ {
			table[i][j] = table[i-1][j-1] + table[i-1][j]
		}
	}
	return table
}

func refBinomial(table [][]int64, n, k int) int64 {
	if n < 0 || k < 0 || k > n {
		return 0
	}
	return table[n][k]
}

func enumerateTuples(alleles, ploidy int) [][]int {
	var tuples [][]int
	current := make([]int, ploidy)
	for {
		tuples = append(tuples, append([]int(nil), current...))
		if !nextTuple(current, alleles) {
			return tuples
		}
	}
}

func TestRankUnrankFullCombinationReference(t *testing.T) {
	table := pascal(20)
	for alleles := 1; alleles <= 5; alleles++ {
		for ploidy := 1; ploidy <= 4; ploidy++ {
			tuples := enumerateTuples(alleles, ploidy)
			expectedCount := refBinomial(table, alleles+ploidy-1, ploidy)
			if int64(len(tuples)) != expectedCount {
				t.Fatalf("N=%d P=%d: enumerated %d tuples, want %d", alleles, ploidy, len(tuples), expectedCount)
			}

			count, err := TupleCount(alleles, ploidy)
			if err != nil {
				t.Fatal(err)
			}
			if count.Int64() != expectedCount {
				t.Fatalf("TupleCount(%d,%d)=%d, want %d", alleles, ploidy, count.Int64(), expectedCount)
			}

			seenRanks := make(map[int64]bool, len(tuples))
			for _, tuple := range tuples {
				rank, err := Rank(tuple, ploidy)
				if err != nil {
					t.Fatalf("Rank(%v): %v", tuple, err)
				}
				// Independent oracle: evaluate the contract formula directly
				// against the Pascal table rather than the production code.
				var expected int64
				for i, allele := range tuple {
					expected += refBinomial(table, allele+i, i+1)
				}
				if rank.Int64() != expected {
					t.Fatalf("N=%d P=%d tuple %v: rank %d, want %d", alleles, ploidy, tuple, rank.Int64(), expected)
				}
				if seenRanks[expected] {
					t.Fatalf("N=%d P=%d: duplicate rank %d", alleles, ploidy, expected)
				}
				seenRanks[expected] = true

				got, err := Unrank(alleles, ploidy, big.NewInt(expected))
				if err != nil {
					t.Fatalf("Unrank(%d): %v", expected, err)
				}
				if !equalInts(got, tuple) {
					t.Fatalf("N=%d P=%d Unrank(%d)=%v, want %v", alleles, ploidy, expected, got, tuple)
				}
			}
			if len(seenRanks) != int(expectedCount) {
				t.Fatalf("N=%d P=%d: ranks covered %d of %d", alleles, ploidy, len(seenRanks), expectedCount)
			}

			outOfRange := new(big.Int).Set(count)
			if _, err := Unrank(alleles, ploidy, outOfRange); !errors.Is(err, ErrInvalidIndex) {
				t.Fatalf("Unrank at count: got %v, want ErrInvalidIndex", err)
			}
			if _, err := Unrank(alleles, ploidy, big.NewInt(-1)); !errors.Is(err, ErrInvalidIndex) {
				t.Fatalf("Unrank(-1): got %v, want ErrInvalidIndex", err)
			}
		}
	}
}

func TestRankFormulaAndInvalidTuples(t *testing.T) {
	// rank(1,1) = C(1,1) + C(2,2) = 2
	rank, err := Rank([]int{1, 1}, 2)
	if err != nil || rank.Int64() != 2 {
		t.Fatalf("Rank([1,1]) = %v, %v", rank, err)
	}
	// rank(0,2) = C(0,1) + C(3,2) = 3
	rank, err = Rank([]int{0, 2}, 2)
	if err != nil || rank.Int64() != 3 {
		t.Fatalf("Rank([0,2]) = %v, %v", rank, err)
	}

	cases := [][]int{
		{1, 0, 2}, // not non-decreasing
		{1, -1},   // negative allele
		{0},       // wrong length for ploidy 2
		nil,       // missing tuple
	}
	for _, tuple := range cases {
		if _, err := Rank(tuple, 2); !errors.Is(err, ErrInvalidTuple) {
			t.Fatalf("Rank(%v): got %v, want ErrInvalidTuple", tuple, err)
		}
	}

	transform, err := NewTransform(3, 3, 2, []int{0, 1, 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transform.RankSource([]int{1, 3}); !errors.Is(err, ErrInvalidTuple) {
		t.Fatalf("RankSource with allele >= N: got %v, want ErrInvalidTuple", err)
	}
	if _, err := NewTransform(3, 3, 17, []int{0, 1, 2}); !errors.Is(err, ErrInvalidPloidy) {
		t.Fatalf("ploidy 17 should be rejected")
	}
	if _, err := NewTransform(0, 3, 2, nil); !errors.Is(err, ErrInvalidAlleleCount) {
		t.Fatalf("allele count 0 should be rejected")
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestMappingValidation(t *testing.T) {
	badMappings := []struct {
		name    string
		n, m, p int
		mapping []int
	}{
		{"wrong length", 3, 3, 2, []int{0, 1}},
		{"reference dropped", 3, 2, 2, []int{Drop, 1, 1}},
		{"reference retargeted", 3, 3, 2, []int{1, 1, 2}},
		{"nonzero onto reference", 3, 2, 2, []int{0, 0, 1}},
		{"target out of range", 3, 3, 2, []int{0, 1, 3}},
		{"negative non-drop", 3, 2, 2, []int{0, -7, 1}},
		{"uncovered target", 4, 3, 2, []int{0, 1, 1, 1}},
	}
	for _, tc := range badMappings {
		if _, err := NewTransform(tc.n, tc.m, tc.p, tc.mapping); !errors.Is(err, ErrInvalidMapping) {
			t.Fatalf("%s: got %v, want ErrInvalidMapping", tc.name, err)
		}
	}

	// Merging several non-zero source alleles onto one target is allowed.
	transform, err := NewTransform(4, 2, 2, []int{0, 1, 1, 1})
	if err != nil {
		t.Fatal(err)
	}
	if got := transform.Mapping(); !equalInts(got, []int{0, 1, 1, 1}) {
		t.Fatalf("Mapping() = %v", got)
	}
	if target, ok := transform.MapAllele(2); !ok || target != 1 {
		t.Fatalf("MapAllele(2) = %d,%v", target, ok)
	}
	if _, ok := transform.MapAllele(99); ok {
		t.Fatalf("MapAllele out of range should report dropped")
	}
}

func uniformRationals(count int) []Rational {
	values := make([]Rational, count)
	for i := range values {
		values[i] = Rational{Num: "1", Den: strconv.Itoa(count)}
	}
	return values
}

func TestMergeManyToOneGenotypes(t *testing.T) {
	// N=4 -> M=3, alleles 1 and 2 merge onto target 1.
	transform, err := NewTransform(4, 3, 2, []int{0, 1, 1, 2})
	if err != nil {
		t.Fatal(err)
	}
	result, err := transform.ConvertVector(uniformRationals(10), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != ProbabilityDefined {
		t.Fatalf("status = %d, want ProbabilityDefined", result.Status)
	}
	if result.Retained != (Rational{Num: "1", Den: "1"}) || result.Discarded != (Rational{Num: "0", Den: "1"}) {
		t.Fatalf("mass: retained=%v discarded=%v", result.Retained, result.Discarded)
	}

	want := map[string]Rational{
		"[0 0]": {Num: "1", Den: "10"},
		"[0 1]": {Num: "1", Den: "5"},  // source (0,1) and (0,2)
		"[1 1]": {Num: "3", Den: "10"}, // source (1,1),(1,2),(2,2)
		"[0 2]": {Num: "1", Den: "10"},
		"[1 2]": {Num: "1", Den: "5"}, // source (1,3),(2,3)
		"[2 2]": {Num: "1", Den: "10"},
	}
	sum := new(big.Rat)
	for rankIndex, probability := range result.Probabilities {
		tuple, err := transform.UnrankTarget(big.NewInt(int64(rankIndex)))
		if err != nil {
			t.Fatal(err)
		}
		expected, ok := want[joinTuple(tuple)]
		if !ok {
			t.Fatalf("unexpected target tuple %v", tuple)
		}
		if probability != expected {
			t.Fatalf("tuple %v: got %v, want %v", tuple, probability, expected)
		}
		sum.Add(sum, new(big.Rat).SetFrac(mustInt(probability.Num), mustInt(probability.Den)))
	}
	if sum.Cmp(big.NewRat(1, 1)) != 0 {
		t.Fatalf("normalized probabilities sum to %s", sum.String())
	}
}

func joinTuple(tuple []int) string {
	out := "["
	for i, value := range tuple {
		if i > 0 {
			out += " "
		}
		out += strconv.Itoa(value)
	}
	return out + "]"
}

func mustInt(s string) *big.Int {
	value, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad integer " + s)
	}
	return value
}
