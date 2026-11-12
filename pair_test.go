package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"math/bits"
	"math/rand"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
)

type decimalString string

func (d decimalString) String() string { return string(d) }

func TestGreedyIsNotGloballyOptimal(t *testing.T) {
	left := []string{"L0", "L1"}
	right := []string{"R0", "R1"}
	candidates := []Candidate{
		{LeftID: "L0", RightID: "R0", Cost: 1},
		{LeftID: "L0", RightID: "R1", Cost: 2},
		{LeftID: "L1", RightID: "R0", Cost: 0},
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if result.MatchCount() != 2 {
		t.Fatalf("match count = %d, want 2", result.MatchCount())
	}
	if got, want := result.TotalCostString(), "2"; got != want {
		t.Fatalf("total cost = %s, want %s", got, want)
	}
	if got, want := result.RightForLeft, []string{"R1", "R0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RightForLeft = %v, want %v", got, want)
	}
}

func TestCardinalityIsPrimaryObjective(t *testing.T) {
	left := []string{"a", "b"}
	right := []string{"x", "y"}
	candidates := []Candidate{
		{LeftID: "a", RightID: "x", Cost: 0},
		{LeftID: "a", RightID: "y", Cost: 100},
		{LeftID: "b", RightID: "y", Cost: 100},
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if result.MatchCount() != 2 {
		t.Fatalf("match count = %d, want 2 even though one match is cheaper", result.MatchCount())
	}
	if got, want := result.TotalCostString(), "100"; got != want {
		t.Fatalf("total cost = %s, want %s", got, want)
	}
}

func TestEmptyInput(t *testing.T) {
	result, err := Match(nil, nil, nil)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if result.MatchCount() != 0 || result.TotalCost.Sign() != 0 {
		t.Fatalf("empty result = %+v", result)
	}
}

func TestSparseCandidates(t *testing.T) {
	left := []string{"a", "b", "c"}
	right := []string{"x", "y", "z"}
	candidates := []Candidate{
		{LeftID: "a", RightID: "x", Cost: 5},
		{LeftID: "b", RightID: "y", Cost: 0},
		{LeftID: "c", RightID: "x", Cost: 7},
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if result.MatchCount() != 2 {
		t.Fatalf("match count = %d, want 2", result.MatchCount())
	}
	if got, want := result.TotalCostString(), "5"; got != want {
		t.Fatalf("total cost = %s, want %s", got, want)
	}
	if got, want := result.RightForLeft, []string{"x", "y", Sentinel}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RightForLeft = %v, want %v", got, want)
	}
	if got, want := result.UnmatchedLeft, []string{"c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("UnmatchedLeft = %v, want %v", got, want)
	}
	if got, want := result.UnmatchedRight, []string{"z"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("UnmatchedRight = %v, want %v", got, want)
	}
}

func TestZeroCostAndLexicographicTieBreak(t *testing.T) {
	left := []string{"L1", "L2", "L3"}
	right := []string{"R1", "R2", "R3"}
	var candidates []Candidate
	for _, l := range left {
		for _, r := range right {
			candidates = append(candidates, Candidate{LeftID: l, RightID: r, Cost: 0})
		}
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if got, want := result.RightForLeft, []string{"R1", "R2", "R3"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RightForLeft = %v, want %v", got, want)
	}
	if got, want := result.TotalCostString(), "0"; got != want {
		t.Fatalf("total cost = %s, want %s", got, want)
	}
}

func TestMultipleOptimalSolutionsUseLexicographicTieBreak(t *testing.T) {
	left := []string{"a", "b"}
	right := []string{"x", "y"}
	candidates := []Candidate{
		{LeftID: "a", RightID: "x", Cost: 5},
		{LeftID: "a", RightID: "y", Cost: 2},
		{LeftID: "b", RightID: "x", Cost: 3},
		{LeftID: "b", RightID: "y", Cost: 0},
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if got, want := result.TotalCostString(), "5"; got != want {
		t.Fatalf("total cost = %s, want %s", got, want)
	}
	if got, want := result.RightForLeft, []string{"x", "y"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RightForLeft = %v, want %v", got, want)
	}
}

func TestUnmatchedSentinelSortsAfterIDs(t *testing.T) {
	left := []string{"a", "b"}
	right := []string{"x"}
	candidates := []Candidate{
		{LeftID: "a", RightID: "x", Cost: 3},
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if got, want := result.RightForLeft, []string{"x", Sentinel}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RightForLeft = %v, want %v", got, want)
	}
	if strings.Compare(result.RightForLeft[0], result.RightForLeft[1]) >= 0 {
		t.Fatalf("matched ID must compare before Sentinel")
	}
}

func TestArbitraryPrecisionCost(t *testing.T) {
	left := []string{"a", "b"}
	right := []string{"x", "y"}
	bigCost := "10000000000000000000000000000000000000000"
	candidates := []Candidate{
		{LeftID: "a", RightID: "x", Cost: bigCost},
		{LeftID: "b", RightID: "y", Cost: bigCost},
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	want := new(big.Int)
	want.SetString(bigCost, 10)
	want.Mul(want, big.NewInt(2))
	if got := result.TotalCostString(); got != want.String() {
		t.Fatalf("total cost = %s, want %s", got, want.String())
	}
}

func TestSupportedCostTypes(t *testing.T) {
	maxUint64 := ^uint64(0)
	tests := []struct {
		name string
		cost any
		want string
	}{
		{name: "int", cost: 7, want: "7"},
		{name: "int64", cost: int64(7), want: "7"},
		{name: "uint64 max", cost: maxUint64, want: new(big.Int).SetUint64(maxUint64).String()},
		{name: "big pointer", cost: big.NewInt(12345), want: "12345"},
		{name: "big value", cost: *big.NewInt(12345), want: "12345"},
		{name: "decimal string", cost: "999999999999999999999999999", want: "999999999999999999999999999"},
		{name: "json number", cost: json.Number("42"), want: "42"},
		{name: "stringer", cost: decimalString("88"), want: "88"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := Match(
				[]string{"l"},
				[]string{"r"},
				[]Candidate{{LeftID: "l", RightID: "r", Cost: tt.cost}},
			)
			if err != nil {
				t.Fatalf("Match() error = %v", err)
			}
			if got := result.TotalCostString(); got != tt.want {
				t.Fatalf("total cost = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestUTF8ByteOrdering(t *testing.T) {
	left := []string{"a", "b"}
	right := []string{"é", "z"}
	var candidates []Candidate
	for _, l := range left {
		for _, r := range right {
			candidates = append(candidates, Candidate{LeftID: l, RightID: r, Cost: 0})
		}
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	// In UTF-8 bytes, "z" (0x7a) sorts before "é" (0xc3 0xa9).
	if got, want := result.RightForLeft, []string{"z", "é"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RightForLeft = %v, want %v", got, want)
	}
}

func TestValidation(t *testing.T) {
	tooMany := make([]string, MaxRecords+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("id-%02d", i)
	}

	tests := []struct {
		name       string
		left       []string
		right      []string
		candidates []Candidate
		wantErr    error
	}{
		{
			name:    "too many left",
			left:    tooMany,
			right:   []string{"r"},
			wantErr: ErrTooManyRecords,
		},
		{
			name:    "too many right",
			left:    []string{"l"},
			right:   tooMany,
			wantErr: ErrTooManyRecords,
		},
		{
			name:    "duplicate left ID",
			left:    []string{"l", "l"},
			right:   []string{"r"},
			wantErr: ErrDuplicateID,
		},
		{
			name:    "duplicate right ID",
			left:    []string{"l"},
			right:   []string{"r", "r"},
			wantErr: ErrDuplicateID,
		},
		{
			name:  "unknown left ID",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "missing", RightID: "r", Cost: 0},
			},
			wantErr: ErrUnknownID,
		},
		{
			name:  "unknown right ID",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "l", RightID: "missing", Cost: 0},
			},
			wantErr: ErrUnknownID,
		},
		{
			name:  "duplicate candidate",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "l", RightID: "r", Cost: 0},
				{LeftID: "l", RightID: "r", Cost: 1},
			},
			wantErr: ErrDuplicateEdge,
		},
		{
			name:  "negative integer cost",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "l", RightID: "r", Cost: -1},
			},
			wantErr: ErrNegativeCost,
		},
		{
			name:  "negative string cost",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "l", RightID: "r", Cost: "-999999999999999999999"},
			},
			wantErr: ErrNegativeCost,
		},
		{
			name:  "invalid string cost",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "l", RightID: "r", Cost: "1.5"},
			},
			wantErr: ErrInvalidCost,
		},
		{
			name:  "nil cost",
			left:  []string{"l"},
			right: []string{"r"},
			candidates: []Candidate{
				{LeftID: "l", RightID: "r", Cost: nil},
			},
			wantErr: ErrInvalidCost,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Match(tt.left, tt.right, tt.candidates)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want errors.Is(%v)", err, tt.wantErr)
			}
		})
	}
}

func TestMaxSizedSparseInput(t *testing.T) {
	left := make([]string, MaxRecords)
	right := make([]string, MaxRecords)
	for i := 0; i < MaxRecords; i++ {
		left[i] = fmt.Sprintf("left-%02d", i)
		right[i] = fmt.Sprintf("right-%02d", i)
	}
	var candidates []Candidate
	for i := 0; i < MaxRecords; i++ {
		candidates = append(candidates, Candidate{
			LeftID:  left[i],
			RightID: right[(i+1)%MaxRecords],
			Cost:    i,
		})
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if result.MatchCount() != MaxRecords {
		t.Fatalf("match count = %d, want %d", result.MatchCount(), MaxRecords)
	}
}

func TestMaxSizedDenseZeroCost(t *testing.T) {
	left := make([]string, MaxRecords)
	right := make([]string, MaxRecords)
	var candidates []Candidate
	for i := 0; i < MaxRecords; i++ {
		left[i] = fmt.Sprintf("L%02d", i)
		right[i] = fmt.Sprintf("R%02d", i)
	}
	for _, l := range left {
		for _, r := range right {
			candidates = append(candidates, Candidate{LeftID: l, RightID: r, Cost: 0})
		}
	}

	result, err := Match(left, right, candidates)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if got, want := result.MatchCount(), MaxRecords; got != want {
		t.Fatalf("match count = %d, want %d", got, want)
	}
	if got, want := result.TotalCostString(), "0"; got != want {
		t.Fatalf("total cost = %s, want %s", got, want)
	}
	if !reflect.DeepEqual(result.RightForLeft, right) {
		t.Fatalf("RightForLeft = %v, want %v", result.RightForLeft, right)
	}
}

func TestAgainstExhaustiveReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for iteration := 0; iteration < 250; iteration++ {
		leftCount := 1 + rng.Intn(5)
		rightCount := 1 + rng.Intn(5)
		left := make([]string, leftCount)
		right := make([]string, rightCount)
		for i := range left {
			left[i] = fmt.Sprintf("L%02d", i)
		}
		for i := range right {
			right[i] = fmt.Sprintf("R%02d", i)
		}

		density := 0.15 + rng.Float64()*0.85
		var candidates []Candidate
		for _, l := range left {
			for _, r := range right {
				if rng.Float64() >= density {
					continue
				}
				cost := rng.Intn(6)
				candidates = append(candidates, Candidate{LeftID: l, RightID: r, Cost: cost})
			}
		}

		got, err := Match(left, right, candidates)
		if err != nil {
			t.Fatalf("iteration %d: Match() error = %v", iteration, err)
		}
		wantCount, wantCost, wantRightForLeft := exhaustiveReference(left, right, candidates)

		if got.MatchCount() != wantCount {
			t.Fatalf("iteration %d: match count = %d, want %d (left=%v right=%v candidates=%+v)",
				iteration, got.MatchCount(), wantCount, left, right, candidates)
		}
		if got.TotalCost.Cmp(wantCost) != 0 {
			t.Fatalf("iteration %d: total cost = %s, want %s", iteration, got.TotalCostString(), wantCost)
		}
		if !reflect.DeepEqual(got.RightForLeft, wantRightForLeft) {
			t.Fatalf("iteration %d: RightForLeft = %v, want %v", iteration, got.RightForLeft, wantRightForLeft)
		}
		assertConsistentResult(t, got, left, right, candidates)
	}
}

func exhaustiveReference(leftIDs, rightIDs []string, candidates []Candidate) (int, *big.Int, []string) {
	left := append([]string(nil), leftIDs...)
	right := append([]string(nil), rightIDs...)
	sort.Strings(left)
	sort.Strings(right)

	leftIndex := make(map[string]int, len(left))
	rightIndex := make(map[string]int, len(right))
	for i, id := range left {
		leftIndex[id] = i
	}
	for i, id := range right {
		rightIndex[id] = i
	}
	matrix := make([][]*big.Int, len(left))
	for i := range matrix {
		matrix[i] = make([]*big.Int, len(right))
	}
	for _, candidate := range candidates {
		matrix[leftIndex[candidate.LeftID]][rightIndex[candidate.RightID]] = referenceCost(candidate.Cost)
	}

	bestCount := -1
	var bestCost *big.Int
	var bestRightForLeft []string
	var visit func(left int, usedMask int, cost *big.Int, assignment []int)
	visit = func(li int, usedMask int, cost *big.Int, assignment []int) {
		if li == len(left) {
			count := bits.OnesCount(uint(usedMask))
			rightForLeft := make([]string, len(left))
			for i, ri := range assignment {
				if ri < 0 {
					rightForLeft[i] = Sentinel
				} else {
					rightForLeft[i] = right[ri]
				}
			}
			if bestCount < 0 ||
				count > bestCount ||
				(count == bestCount && cost.Cmp(bestCost) < 0) ||
				(count == bestCount && cost.Cmp(bestCost) == 0 && byteLexLess(rightForLeft, bestRightForLeft)) {
				bestCount = count
				bestCost = new(big.Int).Set(cost)
				bestRightForLeft = rightForLeft
			}
			return
		}

		// Leave this left record unmatched.
		assignment[li] = -1
		visit(li+1, usedMask, cost, assignment)

		for ri, edgeCost := range matrix[li] {
			if edgeCost == nil || usedMask&(1<<ri) != 0 {
				continue
			}
			assignment[li] = ri
			nextCost := new(big.Int).Add(cost, edgeCost)
			visit(li+1, usedMask|(1<<ri), nextCost, assignment)
		}
	}

	visit(0, 0, new(big.Int), make([]int, len(left)))
	return bestCount, bestCost, bestRightForLeft
}

func referenceCost(value any) *big.Int {
	switch v := value.(type) {
	case int:
		return big.NewInt(int64(v))
	case string:
		cost, ok := new(big.Int).SetString(v, 10)
		if !ok {
			panic("bad test cost")
		}
		return cost
	default:
		panic(fmt.Sprintf("unsupported test cost %T", value))
	}
}

func byteLexLess(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func assertConsistentResult(t *testing.T, result Result, leftIDs, rightIDs []string, candidates []Candidate) {
	t.Helper()

	left := append([]string(nil), leftIDs...)
	right := append([]string(nil), rightIDs...)
	sort.Strings(left)
	sort.Strings(right)
	if got, want := len(result.RightForLeft), len(left); got != want {
		t.Fatalf("len(RightForLeft) = %d, want %d", got, want)
	}

	costByPair := make(map[string]*big.Int)
	for _, candidate := range candidates {
		costByPair[candidate.LeftID+"\x00"+candidate.RightID] = referenceCost(candidate.Cost)
	}
	usedRight := make(map[string]bool)
	matchedLeft := make(map[string]Pair)
	var total big.Int
	for _, pair := range result.Matches {
		if _, exists := matchedLeft[pair.LeftID]; exists {
			t.Fatalf("left ID %q matched more than once", pair.LeftID)
		}
		matchedLeft[pair.LeftID] = pair
		if usedRight[pair.RightID] {
			t.Fatalf("right ID %q matched more than once", pair.RightID)
		}
		usedRight[pair.RightID] = true
		wantCost := costByPair[pair.LeftID+"\x00"+pair.RightID]
		if wantCost == nil || pair.Cost.Cmp(wantCost) != 0 {
			t.Fatalf("cost for (%q, %q) = %v, want %v", pair.LeftID, pair.RightID, pair.Cost, wantCost)
		}
		total.Add(&total, pair.Cost)
	}
	if total.Cmp(result.TotalCost) != 0 {
		t.Fatalf("sum of match costs = %s, want %s", total.String(), result.TotalCostString())
	}

	var wantUnmatchedLeft []string
	wantMatches := make([]Pair, 0, len(result.Matches))
	for i, leftID := range left {
		rightID := result.RightForLeft[i]
		if rightID == Sentinel {
			if _, exists := matchedLeft[leftID]; exists {
				t.Fatalf("left ID %q has Sentinel in RightForLeft but is in Matches", leftID)
			}
			wantUnmatchedLeft = append(wantUnmatchedLeft, leftID)
			continue
		}
		pair, exists := matchedLeft[leftID]
		if !exists || pair.RightID != rightID {
			t.Fatalf("left ID %q has RightForLeft %q but Matches entry is %+v", leftID, rightID, pair)
		}
		wantMatches = append(wantMatches, pair)
	}
	if !reflect.DeepEqual(result.Matches, wantMatches) {
		t.Fatalf("Matches are not in ascending left-ID order: %v", result.Matches)
	}

	var wantUnmatchedRight []string
	for _, id := range right {
		if !usedRight[id] {
			wantUnmatchedRight = append(wantUnmatchedRight, id)
		}
	}
	if !slices.Equal(result.UnmatchedLeft, wantUnmatchedLeft) {
		t.Fatalf("UnmatchedLeft = %v, want %v", result.UnmatchedLeft, wantUnmatchedLeft)
	}
	if !slices.Equal(result.UnmatchedRight, wantUnmatchedRight) {
		t.Fatalf("UnmatchedRight = %v, want %v", result.UnmatchedRight, wantUnmatchedRight)
	}
}
