package leasesim

import "testing"

func TestIntervalOverlapsHalfOpen(t *testing.T) {
	cases := []struct {
		a, b Interval
		want bool
	}{
		{Interval{0, 1}, Interval{1, 2}, false}, // adjacent, half-open
		{Interval{0, 2}, Interval{1, 3}, true},
		{Interval{0, 2}, Interval{2, 4}, false},
		{Interval{1, 3}, Interval{0, 2}, true},
		{Interval{0, 5}, Interval{2, 3}, true}, // containment
		{Interval{2, 3}, Interval{0, 5}, true},
		{Interval{0, 1}, Interval{0, 1}, true}, // identical
	}
	for _, c := range cases {
		if got := c.a.Overlaps(c.b); got != c.want {
			t.Errorf("[%d,%d).Overlaps([%d,%d)) = %v, want %v",
				c.a.Start, c.a.End, c.b.Start, c.b.End, got, c.want)
		}
		if got := c.b.Overlaps(c.a); got != c.want {
			t.Errorf("[%d,%d).Overlaps([%d,%d)) = %v, want %v (symmetry)",
				c.b.Start, c.b.End, c.a.Start, c.a.End, got, c.want)
		}
	}
}

func testConfig() Config {
	return Config{
		Voters: []Voter{
			{ID: "v1", Weight: 2, Domain: "d1"},
			{ID: "v2", Weight: 2, Domain: "d1"},
			{ID: "v3", Weight: 3, Domain: "d2"},
		},
		WeightThreshold: 4, // total weight 7, 2*4 > 7
		DomainThreshold: 2, // 2 domains, 2*2 > 2
	}
}

func TestVoterNeverGrantsOverlappingLeases(t *testing.T) {
	sim := NewSimulator(testConfig())
	sim.Request("A", Interval{0, 2})
	cert := sim.Request("B", Interval{1, 3})
	if len(cert.Grants) != 0 {
		t.Fatalf("expected no grants for overlapping request, got %v", cert.Grants)
	}
	// Adjacent half-open interval [2,3) does not overlap [0,2).
	cert = sim.Request("B", Interval{2, 3})
	if len(cert.Grants) != 3 {
		t.Fatalf("expected 3 grants for adjacent request, got %v", cert.Grants)
	}
}

func TestCertificateValidity(t *testing.T) {
	cfg := testConfig()
	mk := func(grants ...Grant) Certificate {
		return Certificate{Holder: "A", Interval: Interval{0, 1}, Grants: grants}
	}
	valid := mk(
		Grant{VoterID: "v1"}, Grant{VoterID: "v3"}, // weight 5, domains 2
	)
	if !cfg.Valid(valid) {
		t.Error("expected certificate to be valid")
	}
	lowWeight := mk(Grant{VoterID: "v1"}, Grant{VoterID: "v2"}) // weight 4 ok, domains 1
	if cfg.Valid(lowWeight) {
		t.Error("expected invalid: domain threshold not met")
	}
	lowDomains := mk(Grant{VoterID: "v3"}) // weight 3 < 4
	if cfg.Valid(lowDomains) {
		t.Error("expected invalid: weight threshold not met")
	}
	dup := mk(Grant{VoterID: "v3"}, Grant{VoterID: "v3"}) // duplicates count once
	if cfg.Valid(dup) {
		t.Error("expected invalid: duplicate voter grants counted once")
	}
	unknown := mk(Grant{VoterID: "vx"}, Grant{VoterID: "v3"})
	if cfg.Valid(unknown) {
		t.Error("expected invalid: unknown voter ignored")
	}
}

func TestConflictingHoldersCannotBothCertify(t *testing.T) {
	cfg := testConfig()
	sim := NewSimulator(cfg)
	certA := sim.Request("A", Interval{0, 2})
	if !cfg.Valid(certA) {
		t.Fatal("expected A's certificate to be valid")
	}
	certB := sim.Request("B", Interval{0, 2})
	if cfg.Valid(certB) {
		t.Fatal("expected B's overlapping certificate to be invalid")
	}
	if err := CheckSafety(cfg, []Certificate{certA, certB}); err != nil {
		t.Fatal(err)
	}
}

// TestEnumerateSmallHistories exhaustively enumerates every lease-request
// history up to a bounded length over a small alphabet of holders and
// half-open intervals. After every request it verifies the safety property:
// no two valid certificates held by different holders overlap in time.
func TestEnumerateSmallHistories(t *testing.T) {
	cfg := testConfig()
	if !cfg.QuorumsIntersect() {
		t.Fatal("test config must have intersecting quorums")
	}
	holders := []string{"A", "B"}
	intervals := []Interval{
		{0, 1}, {0, 2}, {0, 3}, {1, 2}, {1, 3}, {2, 3},
	}
	const maxDepth = 4

	var histories, certificates, checks int
	var certs []Certificate

	var walk func(sim *Simulator, depth int)
	walk = func(sim *Simulator, depth int) {
		if depth == maxDepth {
			return
		}
		for _, holder := range holders {
			for _, iv := range intervals {
				// Copy the simulator so sibling branches are independent.
				branch := NewSimulator(cfg)
				for id, gs := range sim.grants {
					branch.grants[id] = append([]Grant(nil), gs...)
				}
				cert := branch.Request(holder, iv)
				certs = append(certs, cert)
				if depth == 0 {
					histories++
				}
				certificates++
				if err := CheckSafety(cfg, certs); err != nil {
					t.Fatalf("safety violated: %v", err)
				}
				checks++
				walk(branch, depth+1)
				certs = certs[:len(certs)-1]
			}
		}
	}
	walk(NewSimulator(cfg), 0)
	t.Logf("enumerated %d top-level histories, %d certificates, %d safety checks: all safe",
		histories, certificates, checks)
}
