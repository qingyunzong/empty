package leasesim

import (
	"strings"
	"testing"
)

func testConfig() Config {
	return Config{
		Voters: []Voter{
			{ID: "a", Domain: "A", Weight: 1},
			{ID: "b", Domain: "A", Weight: 1},
			{ID: "c", Domain: "B", Weight: 1},
			{ID: "d", Domain: "C", Weight: 1},
		},
		WeightThreshold: 3,
		DomainThreshold: 2,
	}
}

func mustHistory(t *testing.T, cfg Config, grants ...Grant) *History {
	t.Helper()
	h, err := NewHistory(cfg)
	if err != nil {
		t.Fatalf("NewHistory: %v", err)
	}
	for _, g := range grants {
		if err := h.Add(g); err != nil {
			t.Fatalf("Add(%+v): %v", g, err)
		}
	}
	return h
}

func TestIntervalHalfOpenSemantics(t *testing.T) {
	cases := []struct {
		name    string
		a, b    Interval
		overlap bool
	}{
		{"touching", Interval{0, 2}, Interval{2, 4}, false},
		{"empty interval", Interval{2, 2}, Interval{0, 3}, false},
		{"proper overlap", Interval{0, 3}, Interval{2, 4}, true},
		{"nested", Interval{0, 10}, Interval{3, 4}, true},
		{"disjoint", Interval{0, 1}, Interval{2, 3}, false},
		{"reversed touching", Interval{2, 4}, Interval{0, 2}, false},
	}
	for _, tc := range cases {
		if got := tc.a.Overlaps(tc.b); got != tc.overlap {
			t.Errorf("%s: %v.Overlaps(%v) = %v, want %v", tc.name, tc.a, tc.b, got, tc.overlap)
		}
		if got := tc.b.Overlaps(tc.a); got != tc.overlap {
			t.Errorf("%s: %v.Overlaps(%v) = %v, want %v (symmetry)", tc.name, tc.b, tc.a, got, tc.overlap)
		}
	}
}

func TestIntervalIntersect(t *testing.T) {
	iv, ok := Interval{0, 3}.Intersect(Interval{2, 5})
	if !ok || iv != (Interval{2, 3}) {
		t.Errorf("Intersect([0,3),[2,5)) = %v, %v; want [2,3), true", iv, ok)
	}
	if _, ok := (Interval{0, 2}).Intersect(Interval{2, 4}); ok {
		t.Error("Intersect([0,2),[2,4)) should be empty for half-open intervals")
	}
}

func TestConfigValidate(t *testing.T) {
	if err := testConfig().Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := []Config{
		{Voters: nil, WeightThreshold: 1, DomainThreshold: 1},
		{Voters: []Voter{{ID: "a", Domain: "A", Weight: 1}}, WeightThreshold: 0, DomainThreshold: 1},
		{Voters: []Voter{{ID: "a", Domain: "A", Weight: 1}}, WeightThreshold: 1, DomainThreshold: 0},
		{Voters: []Voter{{ID: "a", Domain: "A", Weight: 0}}, WeightThreshold: 1, DomainThreshold: 1},
		{Voters: []Voter{{ID: "a", Domain: "", Weight: 1}}, WeightThreshold: 1, DomainThreshold: 1},
		{Voters: []Voter{{ID: "a", Domain: "A", Weight: 1}, {ID: "a", Domain: "B", Weight: 1}}, WeightThreshold: 1, DomainThreshold: 1},
	}
	for i, cfg := range bad {
		if err := cfg.Validate(); err == nil {
			t.Errorf("bad config %d accepted", i)
		}
	}
}

func TestQuorumIntersectionGuaranteed(t *testing.T) {
	if !testConfig().QuorumIntersectionGuaranteed() {
		t.Error("testConfig should guarantee quorum intersection (2*3>4 and 2*2>3)")
	}
	loose := testConfig()
	loose.WeightThreshold = 2 // 2*2 <= 4
	if loose.QuorumIntersectionGuaranteed() {
		t.Error("weight threshold 2 of 4 must not guarantee intersection")
	}
	loose = testConfig()
	loose.DomainThreshold = 1 // 2*1 <= 3
	if loose.QuorumIntersectionGuaranteed() {
		t.Error("domain threshold 1 of 3 must not guarantee intersection")
	}
}

func TestHistoryAddRejectsOverlappingGrants(t *testing.T) {
	h := mustHistory(t, testConfig(), Grant{Voter: "a", Interval: Interval{0, 3}})

	if err := h.Add(Grant{Voter: "a", Interval: Interval{2, 5}}); err == nil {
		t.Error("overlapping grant by the same voter accepted")
	} else if !strings.Contains(err.Error(), "overlapping") {
		t.Errorf("unexpected error: %v", err)
	}
	if err := h.Add(Grant{Voter: "a", Interval: Interval{3, 5}}); err != nil {
		t.Errorf("touching grant should be allowed (half-open): %v", err)
	}
	if err := h.Add(Grant{Voter: "b", Interval: Interval{1, 2}}); err != nil {
		t.Errorf("other voter may grant overlapping lease: %v", err)
	}
	if err := h.Add(Grant{Voter: "zzz", Interval: Interval{0, 1}}); err == nil {
		t.Error("grant from unknown voter accepted")
	}
	if err := h.Add(Grant{Voter: "c", Interval: Interval{2, 2}}); err == nil {
		t.Error("empty interval grant accepted")
	}
}

func TestCertificatesThresholds(t *testing.T) {
	h := mustHistory(t, testConfig(),
		Grant{Voter: "a", Interval: Interval{0, 10}},
		Grant{Voter: "b", Interval: Interval{2, 8}},
		Grant{Voter: "c", Interval: Interval{4, 6}},
	)
	certs := h.Certificates()

	// {a,b,c}: weight 3 >= 3, domains {A,B} >= 2, intersection [4,6).
	found := false
	for _, c := range certs {
		if c.Interval == (Interval{4, 6}) && c.Weight == 3 && len(c.Grants) == 3 {
			found = true
			if len(c.Domains) != 2 {
				t.Errorf("cert domains = %v, want 2 distinct", c.Domains)
			}
		}
		// Every emitted certificate must satisfy both thresholds.
		if c.Weight < 3 || len(c.Domains) < 2 {
			t.Errorf("certificate below thresholds: %+v", c)
		}
		if !c.Interval.Valid() {
			t.Errorf("certificate with empty interval: %+v", c)
		}
	}
	if !found {
		t.Error("expected certificate {a,b,c} on [4,6) not found")
	}

	// {a,b} alone has weight 2 < 3 and one domain: no cert with 2 grants.
	for _, c := range certs {
		if len(c.Grants) == 2 {
			t.Errorf("two-voter certificate below thresholds emitted: %+v", c)
		}
	}
}

func TestCertificatesEmptyIntersection(t *testing.T) {
	h := mustHistory(t, testConfig(),
		Grant{Voter: "a", Interval: Interval{0, 2}},
		Grant{Voter: "b", Interval: Interval{2, 4}},
		Grant{Voter: "c", Interval: Interval{0, 4}},
	)
	for _, c := range h.Certificates() {
		usesA, usesB := false, false
		for _, g := range c.Grants {
			if g.Voter == "a" {
				usesA = true
			}
			if g.Voter == "b" {
				usesB = true
			}
		}
		if usesA && usesB {
			t.Errorf("certificate over empty intersection of a and b grants: %+v", c)
		}
	}
}

func TestCheckSafetyDetectsConflict(t *testing.T) {
	// Thresholds too low: two disjoint quorums exist.
	cfg := testConfig()
	cfg.WeightThreshold = 2
	cfg.DomainThreshold = 1
	h := mustHistory(t, cfg,
		Grant{Voter: "a", Interval: Interval{0, 5}},
		Grant{Voter: "b", Interval: Interval{0, 5}},
		Grant{Voter: "c", Interval: Interval{2, 7}},
		Grant{Voter: "d", Interval: Interval{2, 7}},
	)
	a, b := h.CheckSafety()
	if a == nil || b == nil {
		t.Fatal("expected conflicting certificates {a,b} and {c,d} on [2,5)")
	}
	if !a.Conflicts(*b) {
		t.Errorf("reported pair does not conflict: %+v vs %+v", a, b)
	}
}

func TestCheckSafetyCompatibleOverlap(t *testing.T) {
	// Overlapping certificates sharing a voter are the same lease: safe.
	h := mustHistory(t, testConfig(),
		Grant{Voter: "a", Interval: Interval{0, 10}},
		Grant{Voter: "b", Interval: Interval{0, 10}},
		Grant{Voter: "c", Interval: Interval{0, 10}},
		Grant{Voter: "d", Interval: Interval{0, 10}},
	)
	if a, b := h.CheckSafety(); a != nil {
		t.Errorf("false conflict: %+v vs %+v", a, b)
	}
}
