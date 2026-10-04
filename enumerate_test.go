package leasesim

import "testing"

// allGrantSets enumerates every set of pairwise non-overlapping
// half-open intervals with integer endpoints in [0, horizon). Each set
// is a legal grant pattern for a single voter.
func allGrantSets(horizon int64) [][]Interval {
	var ivs []Interval
	for s := int64(0); s < horizon; s++ {
		for e := s + 1; e <= horizon; e++ {
			ivs = append(ivs, Interval{Start: s, End: e})
		}
	}
	var sets [][]Interval
	var rec func(start int, cur []Interval)
	rec = func(start int, cur []Interval) {
		sets = append(sets, append([]Interval(nil), cur...))
		for i := start; i < len(ivs); i++ {
			ok := true
			for _, iv := range cur {
				if iv.Overlaps(ivs[i]) {
					ok = false
					break
				}
			}
			if ok {
				rec(i+1, append(cur, ivs[i]))
			}
		}
	}
	rec(0, nil)
	return sets
}

// enumerateHistories builds every history in which voter i grants one of
// the given grant sets, and calls fn on it.
func enumerateHistories(t *testing.T, cfg Config, sets [][]Interval, fn func(h *History)) {
	t.Helper()
	n := len(cfg.Voters)
	idx := make([]int, n)
	total := 1
	for range cfg.Voters {
		total *= len(sets)
	}
	for ; total > 0; total-- {
		h, err := NewHistory(cfg)
		if err != nil {
			t.Fatalf("NewHistory: %v", err)
		}
		for i, v := range cfg.Voters {
			for _, iv := range sets[idx[i]] {
				if err := h.Add(Grant{Voter: v.ID, Interval: iv}); err != nil {
					t.Fatalf("Add(%q, %v): %v", v.ID, iv, err)
				}
			}
		}
		fn(h)
		for i := n - 1; i >= 0; i-- {
			idx[i]++
			if idx[i] < len(sets) {
				break
			}
			idx[i] = 0
		}
	}
}

// TestExhaustiveSmallHistories enumerates every small history over a
// 3-instant time grid for electorates whose thresholds guarantee quorum
// intersection, and verifies that no two valid certificates conflict.
func TestExhaustiveSmallHistories(t *testing.T) {
	sets := allGrantSets(3)
	t.Logf("grant sets per voter: %d", len(sets))

	configs := map[string]Config{
		"4 voters, 3 domains, uniform weights": testConfig(),
		"3 voters, 2 domains, weighted": {
			Voters: []Voter{
				{ID: "a", Domain: "A", Weight: 2},
				{ID: "b", Domain: "B", Weight: 1},
				{ID: "c", Domain: "B", Weight: 1},
			},
			WeightThreshold: 3, // 2*3 > 4
			DomainThreshold: 2, // 2*2 > 2
		},
	}
	for name, cfg := range configs {
		t.Run(name, func(t *testing.T) {
			if !cfg.QuorumIntersectionGuaranteed() {
				t.Fatal("test config does not guarantee quorum intersection")
			}
			histories := 0
			certs := 0
			enumerateHistories(t, cfg, sets, func(h *History) {
				histories++
				certs += len(h.Certificates())
				if a, b := h.CheckSafety(); a != nil {
					t.Fatalf("conflicting certificates:\n  %+v\n  %+v", a, b)
				}
			})
			t.Logf("checked %d histories, %d certificates: no conflicts", histories, certs)
		})
	}
}

// TestExhaustiveFindsViolationsWhenThresholdsLow confirms the checker is
// not vacuous: with thresholds too low for quorum intersection, the
// enumeration finds histories with conflicting certificates.
func TestExhaustiveFindsViolationsWhenThresholdsLow(t *testing.T) {
	sets := allGrantSets(3)
	cfg := testConfig()
	cfg.WeightThreshold = 2 // 2*2 <= total weight 4
	cfg.DomainThreshold = 1 // 2*1 <= total domains 3

	violations := 0
	enumerateHistories(t, cfg, sets, func(h *History) {
		if a, b := h.CheckSafety(); a != nil {
			violations++
			if !a.Conflicts(*b) {
				t.Fatalf("reported pair does not conflict:\n  %+v\n  %+v", a, b)
			}
		}
	})
	if violations == 0 {
		t.Fatal("expected conflicting certificates with low thresholds, found none")
	}
	t.Logf("low thresholds: %d histories contain conflicting certificates", violations)
}
