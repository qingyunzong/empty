package bitemp

import (
	"fmt"
	"testing"
	"time"
)

var epoch = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

func at(day int) time.Time { return epoch.AddDate(0, 0, day) }

// buildScenario commits an overlapping, out-of-order revision history:
//
//	v1 allow  valid [d0, d10)  committed d0
//	v2 deny   valid [d5, d15)  committed d5   (overlaps v1 on [d5,d10))
//	v3 allow2 valid [d5, d15)  committed d8   (correction, same interval as v2)
//	revoke v3 at d12                                (v2 resurfaces from d12 on)
//	v4 deny2  valid [d20, +∞)  committed d15
func buildScenario(t *testing.T) *Store {
	t.Helper()
	s := NewStore()
	must := func(r Rule, err error) Rule {
		t.Helper()
		if err != nil {
			t.Fatalf("commit: %v", err)
		}
		return r
	}
	must(s.Commit(Rule{ID: "doc:read", Payload: "allow", ValidFrom: at(0), ValidTo: at(10), CommittedAt: at(0)}))
	must(s.Commit(Rule{ID: "doc:read", Payload: "deny", ValidFrom: at(5), ValidTo: at(15), CommittedAt: at(5)}))
	must(s.Commit(Rule{ID: "doc:read", Payload: "allow2", ValidFrom: at(5), ValidTo: at(15), CommittedAt: at(8)}))
	if err := s.Revoke("doc:read", at(12)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	must(s.Commit(Rule{ID: "doc:read", Payload: "deny2", ValidFrom: at(20), CommittedAt: at(15)}))
	return s
}

func TestLatestEffectiveLayerWins(t *testing.T) {
	s := buildScenario(t)
	// Before v3's revocation, the latest committed layer (v3) wins.
	got, ok := s.Query("doc:read", at(7), at(11))
	if !ok || got.Payload != "allow2" || got.Version != 3 {
		t.Fatalf("want v3 allow2, got %+v ok=%v", got, ok)
	}
	// After v3's revocation (as-of >= d12) the older v2 layer resurfaces.
	got, ok = s.Query("doc:read", at(7), at(12))
	if !ok || got.Payload != "deny" || got.Version != 2 {
		t.Fatalf("want v2 deny after revocation, got %+v ok=%v", got, ok)
	}
}

func TestHistoricalQueryIgnoresFutureCommits(t *testing.T) {
	s := buildScenario(t)
	// As-of d6: v3 (committed d8) and v4 (d15) must be invisible.
	got, ok := s.Query("doc:read", at(7), at(6))
	if !ok || got.Version != 2 || got.Payload != "deny" {
		t.Fatalf("want v2 deny as-of d6, got %+v ok=%v", got, ok)
	}
	// As-of d2: only v1 exists.
	got, ok = s.Query("doc:read", at(7), at(2))
	if !ok || got.Version != 1 || got.Payload != "allow" {
		t.Fatalf("want v1 allow as-of d2, got %+v ok=%v", got, ok)
	}
	// v4 committed d15 covers valid d25, but only for as-of >= d15.
	if _, ok = s.Query("doc:read", at(25), at(14)); ok {
		t.Fatal("future commit v4 leaked into as-of d14 query")
	}
	got, ok = s.Query("doc:read", at(25), at(15))
	if !ok || got.Version != 4 || got.Payload != "deny2" {
		t.Fatalf("want v4 deny2 as-of d15, got %+v ok=%v", got, ok)
	}
}

func TestRevokedRecordRetainsSource(t *testing.T) {
	s := buildScenario(t)
	hist := s.History("doc:read")
	if len(hist) != 4 {
		t.Fatalf("want 4 revisions retained, got %d", len(hist))
	}
	v3 := hist[2]
	if v3.RevokedAt == nil || !v3.RevokedAt.Equal(at(12)) {
		t.Fatalf("v3 revocation stamp missing: %+v", v3)
	}
	if v3.Payload != "allow2" {
		t.Fatalf("revoked v3 lost its source payload: %+v", v3)
	}
	// Revoked revision still answers pre-revocation as-of queries.
	got, ok := s.Query("doc:read", at(7), at(11))
	if !ok || got.Version != 3 {
		t.Fatalf("want v3 visible as-of d11, got %+v ok=%v", got, ok)
	}
}

func TestValidIntervalBoundaries(t *testing.T) {
	s := buildScenario(t)
	// ValidTo is exclusive: d10 falls to v2 (which covers [d5,d15)).
	got, ok := s.Query("doc:read", at(10), at(30))
	if !ok || got.Version != 2 {
		t.Fatalf("want v2 at exclusive boundary d10, got %+v ok=%v", got, ok)
	}
	// Nothing covers d18.
	if _, ok := s.Query("doc:read", at(18), at(30)); ok {
		t.Fatal("unexpected hit in uncovered gap d18")
	}
}

// TestGridCrossCheck sweeps the full 2-D (validAt x asOf) grid built from
// every meaningful instant in the log and verifies Query against the
// independent brute-force Recompute, printing the hit version per cell.
func TestGridCrossCheck(t *testing.T) {
	s := buildScenario(t)
	pts := s.GridPoints()
	cells := 0
	for _, validAt := range pts {
		for _, asOf := range pts {
			cells++
			gotQ, okQ := s.Query("doc:read", validAt, asOf)
			gotR, okR := s.Recompute("doc:read", validAt, asOf)
			if okQ != okR {
				t.Fatalf("presence mismatch at valid=%s asOf=%s: query=%v recompute=%v",
					validAt, asOf, okQ, okR)
			}
			if okQ && gotQ.Version != gotR.Version {
				t.Fatalf("version mismatch at valid=%s asOf=%s: query=v%d recompute=v%d",
					validAt, asOf, gotQ.Version, gotR.Version)
			}
		}
	}
	t.Logf("cross-checked %d grid cells (%d x %d instants)", cells, len(pts), len(pts))

	// Emit the hit-version map for the record (rows: validAt, cols: asOf).
	fmt.Println("hit version grid (rows=validAt, cols=asOf, -=miss):")
	header := "            "
	for _, asOf := range pts {
		header += fmt.Sprintf(" %2d", asOf.Day())
	}
	fmt.Println(header)
	for _, validAt := range pts {
		row := fmt.Sprintf("valid d%02d  ", validAt.Day())
		for _, asOf := range pts {
			if r, ok := s.Query("doc:read", validAt, asOf); ok {
				row += fmt.Sprintf(" v%d ", r.Version)
			} else {
				row += "  - "
			}
		}
		fmt.Println(row)
	}
}

// TestGridCrossCheckRandomized fuzzes the invariant with a deterministic
// pseudo-random history: every cell of the grid must agree with Recompute.
func TestGridCrossCheckRandomized(t *testing.T) {
	seed := uint64(42)
	rnd := func(n int) int { // simple LCG, deterministic
		seed = seed*6364136223846793005 + 1442695040888963407
		return int((seed >> 33) % uint64(n))
	}
	for trial := 0; trial < 20; trial++ {
		s := NewStore()
		ids := []string{"a", "b"}
		for i := 0; i < 12; i++ {
			id := ids[rnd(2)]
			from := at(rnd(20))
			to := at(20 + rnd(10))
			if rnd(4) == 0 {
				to = time.Time{} // open-ended
			}
			if _, err := s.Commit(Rule{
				ID: id, Payload: fmt.Sprintf("p%d", i),
				ValidFrom: from, ValidTo: to, CommittedAt: at(i),
			}); err != nil {
				t.Fatalf("trial %d commit: %v", trial, err)
			}
			if rnd(5) == 0 {
				_ = s.Revoke(id, at(i))
			}
		}
		pts := s.GridPoints()
		for _, id := range ids {
			for _, validAt := range pts {
				for _, asOf := range pts {
					gotQ, okQ := s.Query(id, validAt, asOf)
					gotR, okR := s.Recompute(id, validAt, asOf)
					if okQ != okR || (okQ && gotQ.Version != gotR.Version) {
						t.Fatalf("trial %d id=%s valid=%s asOf=%s: query=(v%d,%v) recompute=(v%d,%v)",
							trial, id, validAt, asOf, gotQ.Version, okQ, gotR.Version, okR)
					}
				}
			}
		}
	}
}
