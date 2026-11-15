package dataeng

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"
)

func day(n int) time.Time {
	return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, n)
}

func record(id, entity, group, class string, t time.Time) Record {
	return Record{ID: id, Entity: entity, Group: group, Class: class, Time: t}
}

func testTarget(t *testing.T, split map[SplitName]float64, classes map[string]float64) Target {
	t.Helper()
	target, err := BuildTarget(split, classes)
	if err != nil {
		t.Fatalf("BuildTarget: %v", err)
	}
	return target
}

func TestTransitiveGroupingAndLeakage(t *testing.T) {
	records := []Record{
		record("r1", "e1", "g1", "a", day(1)),
		record("r2", "e2", "g1", "b", day(2)),
		record("r3", "e1", "g2", "a", day(3)),
		record("r4", "e3", "g3", "b", day(4)),
		record("r5", "e4", "g3", "a", day(5)),
		record("r6", "e5", "g4", "b", day(6)),
	}
	cfg := Config{
		Target: testTarget(t, map[SplitName]float64{Train: 2, Validation: 1, Test: 1},
			map[string]float64{"a": 1, "b": 1}),
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Status != StatusOptimal {
		t.Fatalf("status = %s, want optimal; proof=%+v", result.Status, result.Proof)
	}
	if len(result.Blocks) != 3 {
		t.Fatalf("blocks = %d, want 3", len(result.Blocks))
	}
	if got := result.Assignments["r1"]; got != result.Assignments["r2"] || got != result.Assignments["r3"] {
		t.Fatalf("entity/group component crossed splits: %v", result.Assignments)
	}
	if got := result.Assignments["r4"]; got != result.Assignments["r5"] {
		t.Fatalf("entity/group component crossed splits: %v", result.Assignments)
	}
	if err := Verify(records, cfg, result); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestStrictTemporalOrder(t *testing.T) {
	var records []Record
	for i := 0; i < 9; i++ {
		records = append(records, record(fmt.Sprintf("r%02d", i), "", fmt.Sprintf("g%02d", i),
			[]string{"a", "b", "c"}[i%3], day(i)))
	}
	cfg := Config{
		Target: testTarget(t, map[SplitName]float64{Train: 6, Validation: 2, Test: 1},
			map[string]float64{"a": 1, "b": 1, "c": 1}),
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if !result.Feasible {
		t.Fatalf("expected feasible result")
	}
	train := result.TimeBounds[Train]
	test := result.TimeBounds[Test]
	if !test.Earliest.After(train.Latest) {
		t.Fatalf("test earliest %s is not after train latest %s", test.Earliest, train.Latest)
	}
	for _, split := range SplitOrder {
		if result.TimeBounds[split].Count == 0 {
			t.Fatalf("split %s is empty", split)
		}
	}
}

func TestExactTargetCanHaveZeroDeviation(t *testing.T) {
	records := []Record{
		{ID: "r1", Group: "g1", Class: "x", Weight: 8, Time: day(1)},
		{ID: "r2", Group: "g2", Class: "x", Weight: 1, Time: day(2)},
		{ID: "r3", Group: "g3", Class: "x", Weight: 1, Time: day(3)},
	}
	cfg := Config{
		Target:   Target{Train: {"x": 0.8}, Validation: {"x": 0.1}, Test: {"x": 0.1}},
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if deviation := math.Abs(result.Objective); deviation > 1e-12 {
		t.Fatalf("objective = %v, want 0", result.Objective)
	}
	want := map[string]SplitName{"r1": Train, "r2": Validation, "r3": Test}
	for id, split := range want {
		if result.Assignments[id] != split {
			t.Fatalf("assignment for %s = %s, want %s", id, result.Assignments[id], split)
		}
	}
}

func TestConditionalTargetMode(t *testing.T) {
	records := []Record{
		{ID: "r1", Group: "g1", Class: "x", Weight: 8, Time: day(1)},
		{ID: "r2", Group: "g2", Class: "x", Weight: 1, Time: day(2)},
		{ID: "r3", Group: "g3", Class: "x", Weight: 1, Time: day(3)},
	}
	cfg := Config{
		Target: Target{
			Train:      {"x": 1},
			Validation: {"x": 1},
			Test:       {"x": 1},
		},
		TargetMode: TargetConditional,
		SplitShares: map[SplitName]float64{
			Train: 0.8, Validation: 0.1, Test: 0.1,
		},
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Objective > 1e-12 {
		t.Fatalf("objective = %v, want 0", result.Objective)
	}
	if result.Targets[Train]["x"] != 0.8 || result.Targets[Validation]["x"] != 0.1 {
		t.Fatalf("unexpected converted target: %+v", result.Targets)
	}
}

func TestDeterministicTieUsesStableBlockKey(t *testing.T) {
	records := []Record{
		record("r-c", "", "c", "x", time.Time{}),
		record("r-a", "", "a", "x", time.Time{}),
		record("r-b", "", "b", "x", time.Time{}),
	}
	cfg := Config{
		Target:   Target{Train: {"x": 0.8}, Validation: {"x": 0.1}, Test: {"x": 0.1}},
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Status != StatusOptimal {
		t.Fatalf("status = %s, want optimal", result.Status)
	}
	want := map[string]SplitName{"r-a": Train, "r-b": Validation, "r-c": Test}
	for id, split := range want {
		if result.Assignments[id] != split {
			t.Fatalf("assignment for %s = %s, want %s (all: %v)", id, result.Assignments[id], split, result.Assignments)
		}
	}
}

func TestAssignmentIndependentOfInputOrder(t *testing.T) {
	records := make([]Record, 9)
	for i := range records {
		records[i] = Record{
			ID:     fmt.Sprintf("r%02d", i),
			Group:  fmt.Sprintf("g%d", i/2),
			Class:  []string{"a", "b", "c"}[i%3],
			Weight: 1 + float64(i%2),
			Time:   day(i % 5),
		}
	}
	cfg := Config{
		Target: testTarget(t, map[SplitName]float64{Train: 0.6, Validation: 0.2, Test: 0.2},
			map[string]float64{"a": 0.5, "b": 0.3, "c": 0.2}),
		MaxNodes: 200,
	}
	first, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("first Split: %v", err)
	}
	shuffled := append([]Record(nil), records...)
	rng := rand.New(rand.NewSource(7))
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	second, err := Split(shuffled, cfg)
	if err != nil {
		t.Fatalf("second Split: %v", err)
	}
	if math.Abs(first.Objective-second.Objective) > 1e-12 {
		t.Fatalf("objective changed with input order: %v vs %v", first.Objective, second.Objective)
	}
	for id, split := range first.Assignments {
		if second.Assignments[id] != split {
			t.Fatalf("assignment for %s changed with input order: %s vs %s", id, split, second.Assignments[id])
		}
	}
}

func TestBudgetExhaustedReturnsIncumbentAndOpenProof(t *testing.T) {
	var records []Record
	for i := 0; i < 14; i++ {
		class := []string{"a", "b", "c"}[i%3]
		records = append(records, record(fmt.Sprintf("r%02d", i), "", fmt.Sprintf("g%02d", i), class, day(i)))
	}
	cfg := Config{
		Target: testTarget(t, map[SplitName]float64{Train: 0.7, Validation: 0.2, Test: 0.1},
			map[string]float64{"a": 0.5, "b": 0.3, "c": 0.2}),
		MaxNodes: 1,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Status != StatusBudgetExhausted {
		t.Fatalf("status = %s, want budget_exhausted; steps=%d obj=%v proof=%+v", result.Status, result.Steps, result.Objective, result.Proof)
	}
	if !result.Feasible || result.Objective == math.Inf(1) {
		t.Fatalf("expected an incumbent, got %+v", result)
	}
	if result.Proof.Complete {
		t.Fatalf("budget-exhausted proof must be open")
	}
	if result.Steps > 1 {
		t.Fatalf("steps = %d exceeded MaxNodes = 1", result.Steps)
	}
	if result.Proof.OpenCount == 0 || len(result.Proof.Open) == 0 {
		t.Fatalf("expected open frontier, got %+v", result.Proof)
	}
	if result.LowerBound > result.UpperBound+1e-12 {
		t.Fatalf("lower bound %v > upper bound %v", result.LowerBound, result.UpperBound)
	}
	if math.Abs(result.Objective-result.UpperBound) > 1e-12 {
		t.Fatalf("objective %v != upper bound %v", result.Objective, result.UpperBound)
	}
	if err := Verify(records, cfg, result); err != nil {
		t.Fatalf("Verify: %v", err)
	}

	again, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("second Split: %v", err)
	}
	for id, split := range result.Assignments {
		if again.Assignments[id] != split {
			t.Fatalf("non-deterministic assignment for %s: %s vs %s", id, split, again.Assignments[id])
		}
	}
}

func TestExactAgainstBruteForce(t *testing.T) {
	for _, metric := range []Metric{L1, L2, Linf} {
		t.Run(string(metric), func(t *testing.T) {
			for seed := int64(1); seed <= 12; seed++ {
				rng := rand.New(rand.NewSource(seed))
				m := 8
				records := make([]Record, m)
				for i := 0; i < m; i++ {
					class := []string{"a", "b", "c"}[rng.Intn(3)]
					records[i] = Record{
						ID:     fmt.Sprintf("r%02d", i),
						Group:  fmt.Sprintf("g%02d", i),
						Class:  class,
						Time:   day(i / 2),
						Weight: 1 + float64(rng.Intn(3)),
					}
				}
				cfg := Config{
					Target: testTarget(t, map[SplitName]float64{Train: 0.6, Validation: 0.2, Test: 0.2},
						map[string]float64{"a": 0.5, "b": 0.3, "c": 0.2}),
					Metric:   metric,
					MaxNodes: Unlimited,
				}
				result, err := Split(records, cfg)
				if err != nil {
					t.Fatalf("seed %d: Split: %v", seed, err)
				}
				if result.Status != StatusOptimal {
					t.Fatalf("seed %d: status %s, want optimal", seed, result.Status)
				}
				wantObj, wantAsn := bruteForce(t, records, cfg)
				if math.Abs(result.Objective-wantObj) > 1e-9 {
					t.Fatalf("seed %d: objective %v, brute force %v; result=%v brute=%v",
						seed, result.Objective, wantObj, assignmentMap(result, pBlocks(t, records, cfg)), wantAsn)
				}
				gotAsn := resultAssignment(result, pBlocks(t, records, cfg))
				for i := range wantAsn {
					if gotAsn[i] != wantAsn[i] {
						t.Fatalf("seed %d: assignment %v, brute force %v", seed, gotAsn, wantAsn)
					}
				}
				if err := Verify(records, cfg, result); err != nil {
					t.Fatalf("seed %d: Verify: %v", seed, err)
				}
			}
		})
	}
}

func TestBudgetLowerBoundIsValid(t *testing.T) {
	for _, metric := range []Metric{L1, L2, Linf} {
		t.Run(string(metric), func(t *testing.T) {
			for seed := int64(1); seed <= 6; seed++ {
				rng := rand.New(rand.NewSource(1000 + seed))
				records := make([]Record, 8)
				for i := range records {
					records[i] = Record{
						ID:     fmt.Sprintf("r%02d", i),
						Group:  fmt.Sprintf("g%02d", i),
						Class:  []string{"a", "b", "c"}[rng.Intn(3)],
						Time:   day(i),
						Weight: 1 + float64(rng.Intn(3)),
					}
				}
				cfg := Config{
					Target: testTarget(t, map[SplitName]float64{Train: 0.7, Validation: 0.2, Test: 0.1},
						map[string]float64{"a": 0.5, "b": 0.3, "c": 0.2}),
					Metric:   metric,
					MaxNodes: 8,
				}
				result, err := Split(records, cfg)
				if err != nil {
					t.Fatalf("seed %d: Split: %v", seed, err)
				}
				opt, _ := bruteForce(t, records, cfg)
				if result.LowerBound > opt+1e-9 {
					t.Fatalf("seed %d: lower bound %v exceeds optimum %v", seed, result.LowerBound, opt)
				}
				if result.Feasible && result.UpperBound < opt-1e-9 {
					t.Fatalf("seed %d: upper bound %v below optimum %v", seed, result.UpperBound, opt)
				}
				if result.Status == StatusOptimal && math.Abs(result.Objective-opt) > 1e-9 {
					t.Fatalf("seed %d: optimal objective %v, brute force %v", seed, result.Objective, opt)
				}
			}
		})
	}
}

func bruteForce(t *testing.T, records []Record, cfg Config) (float64, []uint8) {
	t.Helper()
	p, err := prepare(records, cfg)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	s := newSolver(p, Unlimited, 0)
	m := len(p.blocks)
	best := math.Inf(1)
	var bestAsn []uint8
	total := 1
	for i := 0; i < m; i++ {
		total *= 3
	}
	for mask := 0; mask < total; mask++ {
		asn := make([]uint8, m)
		x := mask
		for i := 0; i < m; i++ {
			asn[i] = uint8(x % 3)
			x /= 3
		}
		if !s.validAssignment(asn) {
			continue
		}
		obj := s.objective(s.countsFor(asn))
		if math.Abs(obj-best) <= 1e-12 && compareAssignments(asn, bestAsn) >= 0 {
			continue
		}
		if obj < best-1e-12 || (math.Abs(obj-best) <= 1e-12 && compareAssignments(asn, bestAsn) < 0) {
			best = obj
			bestAsn = asn
		}
	}
	if bestAsn == nil {
		t.Fatalf("brute force found no feasible assignment")
	}
	return best, bestAsn
}

func pBlocks(t *testing.T, records []Record, cfg Config) []block {
	t.Helper()
	p, err := prepare(records, cfg)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	return p.blocks
}

func resultAssignment(result Result, blocks []block) []uint8 {
	out := make([]uint8, len(blocks))
	for i, b := range blocks {
		for _, id := range b.recordIdx {
			_ = id
		}
		key := b.key
		for _, gb := range result.Blocks {
			if gb.Key == key {
				out[i] = splitOrdinal(gb.Split)
				break
			}
		}
	}
	return out
}

func assignmentMap(result Result, blocks []block) map[string]SplitName {
	out := make(map[string]SplitName, len(blocks))
	for _, b := range result.Blocks {
		out[b.Key] = b.Split
	}
	return out
}

func splitOrdinal(split SplitName) uint8 {
	for i, candidate := range SplitOrder {
		if candidate == split {
			return uint8(i)
		}
	}
	return 255
}

func TestVerifyRejectsCrossSplitBlock(t *testing.T) {
	records := []Record{
		record("r1", "e", "g1", "a", day(1)),
		record("r2", "e", "g2", "b", day(2)),
		record("r3", "", "g3", "a", day(3)),
	}
	cfg := Config{
		Target:   testTarget(t, map[SplitName]float64{Train: 1, Validation: 1, Test: 1}, map[string]float64{"a": 1, "b": 1}),
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	result.Assignments["r2"] = Test
	if result.Assignments["r1"] == Test {
		result.Assignments["r2"] = Train
	}
	if err := Verify(records, cfg, result); err == nil {
		t.Fatalf("Verify accepted a block crossing splits")
	}
}

func TestInfeasibleWhenThreeNonEmptySplitsCannotBeFormed(t *testing.T) {
	records := []Record{
		record("r1", "e1", "g1", "a", day(1)),
		record("r2", "e2", "g2", "b", day(2)),
	}
	cfg := Config{
		Target:   testTarget(t, map[SplitName]float64{Train: 1, Validation: 1, Test: 1}, map[string]float64{"a": 1, "b": 1}),
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Status != StatusInfeasible {
		t.Fatalf("status = %s, want infeasible", result.Status)
	}
	if !result.Proof.Complete || result.Proof.OpenCount != 0 {
		t.Fatalf("infeasible proof should be closed: %+v", result.Proof)
	}
	if err := Verify(records, cfg, result); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestInfeasibleWhenTrainAndTestTimesOverlap(t *testing.T) {
	records := []Record{
		record("r1", "", "g1", "a", day(1)),
		record("r2", "", "g2", "b", day(1)),
		record("r3", "", "g3", "a", day(1)),
	}
	cfg := Config{
		Target:   testTarget(t, map[SplitName]float64{Train: 1, Validation: 1, Test: 1}, map[string]float64{"a": 1, "b": 1}),
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Status != StatusInfeasible {
		t.Fatalf("status = %s, want infeasible", result.Status)
	}

	cfg.AllowEmptySplits = true
	relaxed, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("relaxed Split: %v", err)
	}
	if !relaxed.Feasible {
		t.Fatalf("empty splits should make this instance feasible")
	}
}

func TestBudgetWithoutIncumbentKeepsSearchOpen(t *testing.T) {
	records := []Record{
		record("r1", "", "g1", "a", day(1)),
		record("r2", "", "g2", "b", day(1)),
		record("r3", "", "g3", "a", day(1)),
	}
	cfg := Config{
		Target:   testTarget(t, map[SplitName]float64{Train: 1, Validation: 1, Test: 1}, map[string]float64{"a": 1, "b": 1}),
		MaxNodes: 1,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Feasible {
		t.Fatalf("did not expect an incumbent")
	}
	if result.Status != StatusBudgetExhausted || result.Proof.Complete {
		t.Fatalf("status=%s proof=%+v, want open budget-exhausted proof", result.Status, result.Proof)
	}
	if result.Proof.OpenCount == 0 {
		t.Fatalf("expected an open frontier")
	}
}

func TestMediumInstanceClosesProof(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	records := make([]Record, 12)
	for i := range records {
		records[i] = Record{
			ID:     fmt.Sprintf("r%02d", i),
			Group:  fmt.Sprintf("g%02d", i),
			Class:  []string{"a", "b", "c", "d"}[rng.Intn(4)],
			Time:   day(i),
			Weight: 1 + float64(rng.Intn(4)),
		}
	}
	cfg := Config{
		Target: testTarget(t, map[SplitName]float64{Train: 0.7, Validation: 0.2, Test: 0.1},
			map[string]float64{"a": 0.4, "b": 0.3, "c": 0.2, "d": 0.1}),
		MaxNodes: Unlimited,
	}
	result, err := Split(records, cfg)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if result.Status != StatusOptimal {
		t.Fatalf("status = %s, want optimal; steps=%d proof=%+v", result.Status, result.Steps, result.Proof)
	}
	if err := Verify(records, cfg, result); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}
