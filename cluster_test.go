package dataeng

import (
	"errors"
	"math/rand"
	"slices"
	"sort"
	"testing"
)

type referencePartition struct {
	feasible bool
	score    int64
	groups   [][]int
}

// referenceSolve enumerates every set partition of the records and applies the
// constraints directly. It is deliberately independent of the atom/solver
// implementation used by Cluster.
func referenceSolve(in Input) referencePartition {
	records := append([]int(nil), in.Records...)
	sort.Ints(records)
	index := make(map[int]int, len(records))
	for i, id := range records {
		index[id] = i
	}

	benefits := make(map[[2]int]int64, len(in.Benefits))
	for _, entry := range in.Benefits {
		left, right := index[entry.A], index[entry.B]
		if left > right {
			left, right = right, left
		}
		benefits[[2]int{left, right}] = entry.Benefit
	}

	mustEdges := make([][2]int, 0, len(in.MustLinks))
	for _, link := range in.MustLinks {
		left, right := index[link.A], index[link.B]
		if left > right {
			left, right = right, left
		}
		mustEdges = append(mustEdges, [2]int{left, right})
	}
	cannotEdges := make([][2]int, 0, len(in.CannotLinks))
	for _, link := range in.CannotLinks {
		left, right := index[link.A], index[link.B]
		if left > right {
			left, right = right, left
		}
		cannotEdges = append(cannotEdges, [2]int{left, right})
	}

	var groups [][]int
	groupOf := make([]int, len(records))
	best := referencePartition{}
	var bestGroups [][]int
	bestFound := false

	var visit func(record int)
	visit = func(record int) {
		if record == len(records) {
			for group, members := range groups {
				for _, member := range members {
					groupOf[member] = group
				}
			}
			for _, edge := range mustEdges {
				if groupOf[edge[0]] != groupOf[edge[1]] {
					return
				}
			}
			for _, edge := range cannotEdges {
				if groupOf[edge[0]] == groupOf[edge[1]] {
					return
				}
			}

			var score int64
			for _, members := range groups {
				for i := 0; i < len(members); i++ {
					for j := i + 1; j < len(members); j++ {
						left, right := members[i], members[j]
						if left > right {
							left, right = right, left
						}
						score += benefits[[2]int{left, right}]
					}
				}
			}

			if !bestFound || score > best.score ||
				(score == best.score && canonicalGroupsLess(groups, bestGroups)) {
				bestFound = true
				best.score = score
				bestGroups = cloneIndexGroups(groups)
			}
			return
		}

		for group := range groups {
			groups[group] = append(groups[group], record)
			visit(record + 1)
			groups[group] = groups[group][:len(groups[group])-1]
		}
		groups = append(groups, []int{record})
		visit(record + 1)
		groups = groups[:len(groups)-1]
	}
	visit(0)
	if bestFound {
		best.feasible = true
		best.groups = cloneGroupIDs(bestGroups, records)
	}
	return best
}

func cloneGroupIDs(groups [][]int, records []int) [][]int {
	cloned := make([][]int, len(groups))
	for i, members := range groups {
		cloned[i] = make([]int, len(members))
		for j, member := range members {
			cloned[i][j] = records[member]
		}
	}
	return cloned
}

func cloneIndexGroups(groups [][]int) [][]int {
	cloned := make([][]int, len(groups))
	for i, members := range groups {
		cloned[i] = append([]int(nil), members...)
	}
	return cloned
}

// canonicalGroupsLess uses sorted group IDs and compares the group list
// lexicographically. A group that is a prefix of another group is smaller.
func canonicalGroupsLess(left, right [][]int) bool {
	for i := 0; i < len(left) && i < len(right); i++ {
		if idsLess(left[i], right[i]) {
			return true
		}
		if idsLess(right[i], left[i]) {
			return false
		}
	}
	return len(left) < len(right)
}

func idsLess(left, right []int) bool {
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] != right[i] {
			return left[i] < right[i]
		}
	}
	return len(left) < len(right)
}

func TestNegativeBenefitsSeparate(t *testing.T) {
	result, err := Solve(
		[]int{2, 0, 1},
		[]PairBenefit{
			{A: 0, B: 1, Benefit: -7},
			{A: 0, B: 2, Benefit: 5},
			{A: 1, B: 2, Benefit: -7},
		},
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	if result.Score != 5 {
		t.Fatalf("score = %d, want 5", result.Score)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{0, 2}, {1}})

	result, err = Solve(
		[]int{0, 1, 2},
		[]PairBenefit{
			{A: 0, B: 1, Benefit: -2},
			{A: 0, B: 2, Benefit: -4},
			{A: 1, B: 2, Benefit: -3},
		},
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	if result.Score != 0 {
		t.Fatalf("all-negative score = %d, want 0", result.Score)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{0}, {1}, {2}})
}

func TestTieBreakCanonical(t *testing.T) {
	// Both {0,1}|{2} and {0}|{1,2} score 4. The canonical group list
	// [[0],[1,2]] is smaller than [[0,1],[2]] because [0] is a prefix of [0,1].
	result, err := Solve(
		[]int{0, 1, 2},
		[]PairBenefit{
			{A: 0, B: 1, Benefit: 4},
			{A: 1, B: 2, Benefit: 4},
			{A: 0, B: 2, Benefit: -100},
		},
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	if result.Score != 4 {
		t.Fatalf("score = %d, want 4", result.Score)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{0}, {1, 2}})

	// With every benefit zero, all partitions tie. The lexicographically
	// smallest canonical group list is all singletons.
	result, err = Solve([]int{3, 1, 2, 0}, nil, nil, nil)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	if result.Score != 0 {
		t.Fatalf("zero-benefit score = %d, want 0", result.Score)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{0}, {1}, {2}, {3}})

	// A must-link removes the corresponding singletons from the tie set.
	result, err = Solve(
		[]int{0, 1, 2, 3},
		nil,
		[]Constraint{{A: 2, B: 3}},
		nil,
	)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{0}, {1}, {2, 3}})
}

func TestMustLinkTransitiveAndConflictChain(t *testing.T) {
	result, err := Solve(
		[]int{0, 1, 2},
		nil,
		[]Constraint{{A: 0, B: 1}, {A: 1, B: 2}},
		[]Constraint{{A: 0, B: 2}},
	)
	if !errors.Is(err, ErrUnsatisfiable) {
		t.Fatalf("error = %v, want ErrUnsatisfiable", err)
	}
	if result.Feasible || result.Conflict == nil {
		t.Fatalf("result = %+v, want infeasible with conflict", result)
	}
	conflict := result.Conflict
	if conflict.CannotLink != (Constraint{A: 0, B: 2}) {
		t.Fatalf("cannot-link = %+v, want (0,2)", conflict.CannotLink)
	}
	if !slices.Equal(conflict.MustLinkPath, []int{0, 1, 2}) {
		t.Fatalf("must-link path = %v, want [0 1 2]", conflict.MustLinkPath)
	}
	wantChain := []ChainLink{
		{Kind: KindMustLink, A: 0, B: 1},
		{Kind: KindMustLink, A: 1, B: 2},
		{Kind: KindCannotLink, A: 0, B: 2},
	}
	if !slices.Equal(conflict.Chain, wantChain) {
		t.Fatalf("chain = %+v, want %+v", conflict.Chain, wantChain)
	}

	// Must-link closure fuses the whole cycle into one legal group.
	result, err = Solve(
		[]int{10, 20, 30},
		[]PairBenefit{
			{A: 10, B: 20, Benefit: 1},
			{A: 20, B: 30, Benefit: 2},
			{A: 10, B: 30, Benefit: 3},
		},
		[]Constraint{
			{A: 10, B: 20},
			{A: 20, B: 30},
			{A: 30, B: 10},
		},
		nil,
	)
	if err != nil {
		t.Fatalf("satisfiable must-link cycle returned error: %v", err)
	}
	if result.Score != 6 {
		t.Fatalf("must-link cycle score = %d, want 6", result.Score)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{10, 20, 30}})
}

func TestConflictSelectionIsDeterministic(t *testing.T) {
	result, err := Solve(
		[]int{0, 1, 2},
		nil,
		[]Constraint{{A: 0, B: 1}, {A: 1, B: 2}},
		[]Constraint{{A: 0, B: 1}, {A: 0, B: 2}},
	)
	if !errors.Is(err, ErrUnsatisfiable) {
		t.Fatalf("error = %v, want ErrUnsatisfiable", err)
	}
	if result.Conflict.CannotLink != (Constraint{A: 0, B: 1}) {
		t.Fatalf("selected conflict = %+v, want canonical first pair (0,1)",
			result.Conflict.CannotLink)
	}
	if !slices.Equal(result.Conflict.MustLinkPath, []int{0, 1}) {
		t.Fatalf("path = %v, want [0 1]", result.Conflict.MustLinkPath)
	}
}

func TestSelfCannotLink(t *testing.T) {
	result, err := Solve(
		[]int{0, 1},
		nil,
		nil,
		[]Constraint{{A: 1, B: 1}},
	)
	if !errors.Is(err, ErrUnsatisfiable) {
		t.Fatalf("error = %v, want ErrUnsatisfiable", err)
	}
	if result.Conflict == nil || result.Conflict.CannotLink != (Constraint{A: 1, B: 1}) {
		t.Fatalf("conflict = %+v, want self cannot-link (1,1)", result.Conflict)
	}
	if !slices.Equal(result.Conflict.MustLinkPath, []int{1}) {
		t.Fatalf("path = %v, want [1]", result.Conflict.MustLinkPath)
	}
}

func TestCannotLinkCycleIsLegalWhenSeparated(t *testing.T) {
	result, err := Solve(
		[]int{0, 1, 2},
		[]PairBenefit{
			{A: 0, B: 1, Benefit: 10},
			{A: 1, B: 2, Benefit: 10},
			{A: 0, B: 2, Benefit: 10},
		},
		nil,
		[]Constraint{
			{A: 0, B: 1},
			{A: 1, B: 2},
			{A: 2, B: 0},
		},
	)
	if err != nil {
		t.Fatalf("cannot-link cycle should be satisfiable: %v", err)
	}
	if result.Score != 0 {
		t.Fatalf("score = %d, want 0", result.Score)
	}
	assertGroups(t, result.GroupIDs(), [][]int{{0}, {1}, {2}})
}

func TestGroupBasisAndTransitivePaths(t *testing.T) {
	result, err := Solve(
		[]int{0, 1, 2},
		[]PairBenefit{
			{A: 0, B: 1, Benefit: -5},
			{A: 0, B: 2, Benefit: 10},
			{A: 1, B: 2, Benefit: 0},
		},
		[]Constraint{{A: 0, B: 1}, {A: 1, B: 2}},
		nil,
	)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	if result.Score != 5 {
		t.Fatalf("score = %d, want 5", result.Score)
	}
	if len(result.Groups) != 1 {
		t.Fatalf("groups = %v, want one forced group", result.GroupIDs())
	}
	group := result.Groups[0]
	if want := []int{0, 1, 2}; !slices.Equal(group.IDs, want) {
		t.Fatalf("group IDs = %v, want %v", group.IDs, want)
	}
	if len(group.Basis) != 3 {
		t.Fatalf("basis length = %d, want 3", len(group.Basis))
	}
	var basisScore int64
	for _, pair := range group.Basis {
		basisScore += pair.Benefit
		if !pair.MustLink {
			t.Fatalf("pair %v is must-linked but basis says otherwise", pair)
		}
		if pair.Reason != BasisMustLink {
			t.Fatalf("pair %v reason = %q, want %q", pair, pair.Reason, BasisMustLink)
		}
		if len(pair.MustLinkPath) < 2 ||
			pair.MustLinkPath[0] != pair.A ||
			pair.MustLinkPath[len(pair.MustLinkPath)-1] != pair.B {
			t.Fatalf("pair %v has invalid must-link path %v", pair, pair.MustLinkPath)
		}
	}
	if basisScore != group.Score {
		t.Fatalf("basis score = %d, group score = %d", basisScore, group.Score)
	}
	if result.Groups[0].Score != result.Score {
		t.Fatalf("group score = %d, result score = %d",
			result.Groups[0].Score, result.Score)
	}
}

func TestExhaustiveAllSetPartitions(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	idPool := []int{-73, -11, 0, 2, 7, 19, 31, 44, 58, 71, 96, 120}

	cases := 0
	for size := 1; size <= 8; size++ {
		for iteration := 0; iteration < 35; iteration++ {
			permutation := rng.Perm(len(idPool))
			records := make([]int, size)
			for i := 0; i < size; i++ {
				records[i] = idPool[permutation[i]]
			}

			var benefits []PairBenefit
			for i := 0; i < size; i++ {
				for j := i + 1; j < size; j++ {
					if rng.Intn(4) == 0 {
						continue
					}
					benefits = append(benefits, PairBenefit{
						A:       records[i],
						B:       records[j],
						Benefit: int64(rng.Intn(23) - 11),
					})
				}
			}

			randomPair := func() (int, int) {
				return records[rng.Intn(size)], records[rng.Intn(size)]
			}
			var mustLinks, cannotLinks []Constraint
			for i := 0; i < rng.Intn(6); i++ {
				left, right := randomPair()
				mustLinks = append(mustLinks, Constraint{A: left, B: right})
			}
			for i := 0; i < rng.Intn(6); i++ {
				left, right := randomPair()
				cannotLinks = append(cannotLinks, Constraint{A: left, B: right})
			}

			input := Input{
				Records:     records,
				Benefits:    benefits,
				MustLinks:   mustLinks,
				CannotLinks: cannotLinks,
			}
			got, err := Cluster(input)
			want := referenceSolve(input)

			if !want.feasible {
				if !errors.Is(err, ErrUnsatisfiable) {
					t.Fatalf("size=%d case=%d: error = %v, want ErrUnsatisfiable; input=%+v",
						size, iteration, err, input)
				}
				if got.Feasible || got.Conflict == nil {
					t.Fatalf("size=%d case=%d: got feasible=%v conflict=%v",
						size, iteration, got.Feasible, got.Conflict)
				}
				validateConflict(t, input, got.Conflict, size, iteration)
			} else {
				if err != nil {
					t.Fatalf("size=%d case=%d: unexpected error %v; input=%+v",
						size, iteration, err, input)
				}
				if !got.Feasible {
					t.Fatalf("size=%d case=%d: got infeasible, want feasible", size, iteration)
				}
				if got.Score != want.score {
					t.Fatalf("size=%d case=%d: score = %d, want %d; input=%+v",
						size, iteration, got.Score, want.score, input)
				}
				if !groupsEqual(got.GroupIDs(), want.groups) {
					t.Fatalf("size=%d case=%d: groups = %v, want %v; input=%+v",
						size, iteration, got.GroupIDs(), want.groups, input)
				}
				validateResult(t, input, got, size, iteration)
			}
			cases++
		}
	}
	t.Logf("checked %d randomized cases by enumerating every set partition", cases)
}

func TestExhaustiveNineAndTenRecords(t *testing.T) {
	rng := rand.New(rand.NewSource(99173))
	sizes := []int{9, 9, 9, 10, 10}
	for _, size := range sizes {
		input := randomInput(rng, size)
		got, err := Cluster(input)
		want := referenceSolve(input)

		if !want.feasible {
			if !errors.Is(err, ErrUnsatisfiable) || got.Conflict == nil {
				t.Fatalf("size=%d: error=%v conflict=%v, want unsatisfiable witness",
					size, err, got.Conflict)
			}
			validateConflict(t, input, got.Conflict, size, -1)
			continue
		}
		if err != nil {
			t.Fatalf("size=%d: unexpected error %v; input=%+v", size, err, input)
		}
		if got.Score != want.score {
			t.Fatalf("size=%d: score=%d, want %d; input=%+v",
				size, got.Score, want.score, input)
		}
		if !groupsEqual(got.GroupIDs(), want.groups) {
			t.Fatalf("size=%d: groups=%v, want %v; input=%+v",
				size, got.GroupIDs(), want.groups, input)
		}
		validateResult(t, input, got, size, -1)
	}
}

func randomInput(rng *rand.Rand, size int) Input {
	idPool := []int{-73, -11, 0, 2, 7, 19, 31, 44, 58, 71, 96, 120}
	permutation := rng.Perm(len(idPool))
	records := make([]int, size)
	for i := 0; i < size; i++ {
		records[i] = idPool[permutation[i]]
	}

	var benefits []PairBenefit
	for i := 0; i < size; i++ {
		for j := i + 1; j < size; j++ {
			if rng.Intn(5) == 0 {
				continue
			}
			benefits = append(benefits, PairBenefit{
				A:       records[i],
				B:       records[j],
				Benefit: int64(rng.Intn(31) - 15),
			})
		}
	}

	randomPair := func() (int, int) {
		return records[rng.Intn(size)], records[rng.Intn(size)]
	}
	var mustLinks, cannotLinks []Constraint
	for i := 0; i < rng.Intn(8); i++ {
		left, right := randomPair()
		mustLinks = append(mustLinks, Constraint{A: left, B: right})
	}
	for i := 0; i < rng.Intn(8); i++ {
		left, right := randomPair()
		cannotLinks = append(cannotLinks, Constraint{A: left, B: right})
	}
	return Input{
		Records:     records,
		Benefits:    benefits,
		MustLinks:   mustLinks,
		CannotLinks: cannotLinks,
	}
}

func validateConflict(t *testing.T, in Input, conflict *Conflict, size, iteration int) {
	t.Helper()
	if len(conflict.MustLinkPath) == 0 {
		t.Fatalf("size=%d case=%d: empty conflict path", size, iteration)
	}
	if conflict.MustLinkPath[0] != conflict.CannotLink.A ||
		conflict.MustLinkPath[len(conflict.MustLinkPath)-1] != conflict.CannotLink.B {
		t.Fatalf("size=%d case=%d: path %v does not connect cannot-link %+v",
			size, iteration, conflict.MustLinkPath, conflict.CannotLink)
	}
	for i := 0; i+1 < len(conflict.MustLinkPath); i++ {
		if !hasConstraint(in.MustLinks, conflict.MustLinkPath[i], conflict.MustLinkPath[i+1]) {
			t.Fatalf("size=%d case=%d: path step (%d,%d) is not a must-link",
				size, iteration, conflict.MustLinkPath[i], conflict.MustLinkPath[i+1])
		}
	}
	if !hasConstraint(in.CannotLinks, conflict.CannotLink.A, conflict.CannotLink.B) {
		t.Fatalf("size=%d case=%d: conflict cannot-link %+v is not an input constraint",
			size, iteration, conflict.CannotLink)
	}
	if len(conflict.Chain) != len(conflict.MustLinkPath) {
		t.Fatalf("size=%d case=%d: chain length %d, path length %d",
			size, iteration, len(conflict.Chain), len(conflict.MustLinkPath))
	}
	for i := 0; i+1 < len(conflict.MustLinkPath); i++ {
		link := conflict.Chain[i]
		if link.Kind != KindMustLink ||
			link.A != conflict.MustLinkPath[i] ||
			link.B != conflict.MustLinkPath[i+1] {
			t.Fatalf("size=%d case=%d: bad chain link %+v", size, iteration, link)
		}
	}
	last := conflict.Chain[len(conflict.Chain)-1]
	if last.Kind != KindCannotLink ||
		last.A != conflict.CannotLink.A ||
		last.B != conflict.CannotLink.B {
		t.Fatalf("size=%d case=%d: bad final chain link %+v", size, iteration, last)
	}
}

func validateResult(t *testing.T, in Input, result Result, size, iteration int) {
	t.Helper()
	seen := make(map[int]bool, len(in.Records))
	var groupScore int64
	for _, group := range result.Groups {
		groupScore += group.Score
		if len(group.IDs) == 0 {
			t.Fatalf("size=%d case=%d: empty group", size, iteration)
		}
		if !sort.IntsAreSorted(group.IDs) {
			t.Fatalf("size=%d case=%d: group IDs are not sorted: %v",
				size, iteration, group.IDs)
		}
		if len(group.Basis) != len(group.IDs)*(len(group.IDs)-1)/2 {
			t.Fatalf("size=%d case=%d: basis has %d pairs for %d IDs",
				size, iteration, len(group.Basis), len(group.IDs))
		}
		var basisScore int64
		for _, pair := range group.Basis {
			if pair.A >= pair.B {
				t.Fatalf("size=%d case=%d: malformed basis pair %+v", size, iteration, pair)
			}
			basisScore += pair.Benefit
		}
		if basisScore != group.Score {
			t.Fatalf("size=%d case=%d: basis score %d, group score %d",
				size, iteration, basisScore, group.Score)
		}
		for _, id := range group.IDs {
			if seen[id] {
				t.Fatalf("size=%d case=%d: record %d appears twice", size, iteration, id)
			}
			seen[id] = true
		}
	}
	if groupScore != result.Score {
		t.Fatalf("size=%d case=%d: group total %d, result score %d",
			size, iteration, groupScore, result.Score)
	}
	if len(seen) != len(in.Records) {
		t.Fatalf("size=%d case=%d: %d records covered, want %d",
			size, iteration, len(seen), len(in.Records))
	}
}

func hasConstraint(links []Constraint, a, b int) bool {
	for _, link := range links {
		if (link.A == a && link.B == b) || (link.A == b && link.B == a) {
			return true
		}
	}
	return false
}

func TestMaxRecords(t *testing.T) {
	records := make([]int, MaxRecords)
	for i := range records {
		records[i] = i
	}
	result, err := Solve(records, nil, nil, nil)
	if err != nil {
		t.Fatalf("Solve returned error: %v", err)
	}
	if result.Score != 0 {
		t.Fatalf("score = %d, want 0", result.Score)
	}
	want := make([][]int, MaxRecords)
	for i := range want {
		want[i] = []int{i}
	}
	assertGroups(t, result.GroupIDs(), want)
}

func TestInputValidation(t *testing.T) {
	tooMany := make([]int, MaxRecords+1)
	for i := range tooMany {
		tooMany[i] = i
	}

	tests := []struct {
		name   string
		input  Input
		target error
	}{
		{
			name:   "too many records",
			input:  Input{Records: tooMany},
			target: ErrTooManyRecords,
		},
		{
			name:   "duplicate record",
			input:  Input{Records: []int{0, 0, 1}},
			target: ErrDuplicateRecord,
		},
		{
			name: "unknown benefit record",
			input: Input{
				Records:  []int{0, 1},
				Benefits: []PairBenefit{{A: 0, B: 9, Benefit: 3}},
			},
			target: ErrUnknownRecord,
		},
		{
			name: "unknown must-link record",
			input: Input{
				Records:   []int{0, 1},
				MustLinks: []Constraint{{A: 0, B: 9}},
			},
			target: ErrUnknownRecord,
		},
		{
			name: "unknown cannot-link record",
			input: Input{
				Records:     []int{0, 1},
				CannotLinks: []Constraint{{A: 0, B: 9}},
			},
			target: ErrUnknownRecord,
		},
		{
			name: "self benefit",
			input: Input{
				Records:  []int{0, 1},
				Benefits: []PairBenefit{{A: 0, B: 0, Benefit: 3}},
			},
			target: ErrSelfBenefit,
		},
		{
			name: "duplicate benefit reversed",
			input: Input{
				Records: []int{0, 1},
				Benefits: []PairBenefit{
					{A: 0, B: 1, Benefit: 3},
					{A: 1, B: 0, Benefit: 4},
				},
			},
			target: ErrDuplicateBenefit,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Cluster(test.input)
			if !errors.Is(err, test.target) {
				t.Fatalf("error = %v, want %v", err, test.target)
			}
		})
	}
}

func TestEmptyInput(t *testing.T) {
	result, err := Cluster(Input{})
	if err != nil {
		t.Fatalf("Cluster returned error: %v", err)
	}
	if !result.Feasible || result.Score != 0 || len(result.Groups) != 0 {
		t.Fatalf("result = %+v, want feasible empty partition", result)
	}
}

func assertGroups(t *testing.T, got, want [][]int) {
	t.Helper()
	if !groupsEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
}

func groupsEqual(left, right [][]int) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if !slices.Equal(left[i], right[i]) {
			return false
		}
	}
	return true
}
