package dataeng

import (
	"errors"
	"fmt"
	"math"
	"testing"
)

func testConfig() Config {
	return Config{Width: 512, Depth: 5, Seed: 42, Epsilon: 0.01, Decay: 0.5}
}

func TestAddAndEstimate(t *testing.T) {
	s, err := New(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if err := s.Add("flow-a", 1); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 10; i++ {
		if err := s.Add("flow-b", 1); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.Estimate("flow-a"); got < 100 {
		t.Fatalf("estimate undershot true count: %v", got)
	}
	if got := s.Estimate("flow-a"); got > 100+s.MissBound() {
		t.Fatalf("estimate %v exceeds true count + miss bound %v", got, s.MissBound())
	}
	if got := s.TotalWeight(); got != 110 {
		t.Fatalf("total weight = %v, want 110", got)
	}
}

func TestInvalidConfig(t *testing.T) {
	cases := []Config{
		{Width: 0, Depth: 5, Seed: 1, Epsilon: 0.01, Decay: 1},
		{Width: 8, Depth: 0, Seed: 1, Epsilon: 0.01, Decay: 1},
		{Width: 8, Depth: 2, Seed: 1, Epsilon: 0, Decay: 1},
		{Width: 8, Depth: 2, Seed: 1, Epsilon: 1, Decay: 1},
		{Width: 8, Depth: 2, Seed: 1, Epsilon: 0.01, Decay: 0},
		{Width: 8, Depth: 2, Seed: 1, Epsilon: 0.01, Decay: 1.5},
	}
	for i, cfg := range cases {
		if _, err := New(cfg); err == nil {
			t.Errorf("case %d: expected error for %+v", i, cfg)
		}
	}
}

func TestStrictTurnstile(t *testing.T) {
	s, err := New(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Add("flow-a", 5); err != nil {
		t.Fatal(err)
	}
	if err := s.Add("flow-a", -3); err != nil {
		t.Fatalf("valid negative update rejected: %v", err)
	}
	if got := s.TotalWeight(); got != 2 {
		t.Fatalf("total weight = %v, want 2", got)
	}
	err = s.Add("flow-a", -10)
	if !errors.Is(err, ErrNegativeCount) {
		t.Fatalf("expected ErrNegativeCount, got %v", err)
	}
	if got := s.Estimate("flow-a"); got != 2 {
		t.Fatalf("sketch mutated after rejected update: estimate = %v, want 2", got)
	}
	if err := s.Add("never-seen", -1); !errors.Is(err, ErrNegativeCount) {
		t.Fatalf("negative update on unseen item: got %v", err)
	}
}

func TestMergeRequiresIdenticalParams(t *testing.T) {
	a, err := New(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Add("flow-a", 7); err != nil {
		t.Fatal(err)
	}
	if err := b.Add("flow-b", 3); err != nil {
		t.Fatal(err)
	}
	if err := a.Merge(b); err != nil {
		t.Fatalf("merge of identical configs: %v", err)
	}
	if got := a.TotalWeight(); got != 10 {
		t.Fatalf("merged total = %v, want 10", got)
	}
	if got := a.Estimate("flow-a"); got != 7 {
		t.Fatalf("merged estimate = %v, want 7", got)
	}

	mismatches := []Config{
		{Width: 256, Depth: 5, Seed: 42, Epsilon: 0.01, Decay: 0.5},
		{Width: 512, Depth: 4, Seed: 42, Epsilon: 0.01, Decay: 0.5},
		{Width: 512, Depth: 5, Seed: 43, Epsilon: 0.01, Decay: 0.5},
		{Width: 512, Depth: 5, Seed: 42, Epsilon: 0.02, Decay: 0.5},
		{Width: 512, Depth: 5, Seed: 42, Epsilon: 0.01, Decay: 0.25},
	}
	for i, cfg := range mismatches {
		other, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := a.Merge(other); !errors.Is(err, ErrIncompatibleMerge) {
			t.Errorf("case %d: expected ErrIncompatibleMerge, got %v", i, err)
		}
	}
	if err := a.Merge(nil); !errors.Is(err, ErrIncompatibleMerge) {
		t.Errorf("nil merge: expected ErrIncompatibleMerge, got %v", err)
	}
}

func TestMergeRequiresSameGeneration(t *testing.T) {
	a, _ := New(testConfig())
	b, _ := New(testConfig())
	b.AdvanceGeneration()
	if err := a.Merge(b); !errors.Is(err, ErrIncompatibleMerge) {
		t.Fatalf("expected ErrIncompatibleMerge across generations, got %v", err)
	}
}

func TestDecayGeneration(t *testing.T) {
	s, _ := New(testConfig())
	if err := s.Add("flow-a", 10); err != nil {
		t.Fatal(err)
	}
	s.AdvanceGeneration()
	if got := s.Generation(); got != 1 {
		t.Fatalf("generation = %d, want 1", got)
	}
	if got := s.TotalWeight(); got != 5 {
		t.Fatalf("decayed total = %v, want 5", got)
	}
	if got := s.Estimate("flow-a"); got != 5 {
		t.Fatalf("decayed estimate = %v, want 5", got)
	}
}

func TestHeavyHitterMissBound(t *testing.T) {
	cfg := testConfig()
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	trueCounts := map[string]float64{}
	// One dominant heavy hitter plus a long tail of small flows.
	for i := 0; i < 500; i++ {
		if err := s.Add("heavy", 1); err != nil {
			t.Fatal(err)
		}
	}
	trueCounts["heavy"] = 500
	for i := 0; i < 2000; i++ {
		item := fmt.Sprintf("tail-%d", i)
		if err := s.Add(item, 1); err != nil {
			t.Fatal(err)
		}
		trueCounts[item] = 1
	}
	if got, want := len(s.Candidates()), int(math.Ceil(1/cfg.Epsilon)); got > want {
		t.Fatalf("candidate set size %d exceeds fixed bound %d", got, want)
	}
	bound := s.MissBound()
	if want := cfg.Epsilon * s.TotalWeight(); bound != want {
		t.Fatalf("miss bound = %v, want %v", bound, want)
	}
	inCandidates := map[string]bool{}
	for _, c := range s.Candidates() {
		inCandidates[c.Item] = true
	}
	for item, count := range trueCounts {
		if count > bound && !inCandidates[item] {
			t.Errorf("item %q with true count %v above miss bound %v missing from candidates", item, count, bound)
		}
	}
	if !inCandidates["heavy"] {
		t.Error("dominant heavy hitter missing from candidates")
	}
}

func TestCandidatesSortedDescending(t *testing.T) {
	s, _ := New(testConfig())
	_ = s.Add("a", 1)
	_ = s.Add("b", 9)
	_ = s.Add("c", 5)
	cands := s.Candidates()
	for i := 1; i < len(cands); i++ {
		if cands[i-1].Estimate < cands[i].Estimate {
			t.Fatalf("candidates not sorted descending: %+v", cands)
		}
	}
}

func TestSeedChangesLayout(t *testing.T) {
	a, _ := New(testConfig())
	cfg := testConfig()
	cfg.Seed = 7
	b, _ := New(cfg)
	same := 0
	for row := 0; row < int(cfg.Depth); row++ {
		if a.column("flow-a", row) == b.column("flow-a", row) {
			same++
		}
	}
	if same == int(cfg.Depth) {
		t.Fatal("different seeds produced identical column layouts")
	}
}
