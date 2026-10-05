package bitemp

import (
	"fmt"
	"math/rand"
	"testing"
	"time"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func day(n int) time.Time { return epoch.AddDate(0, 0, n) }

func mustCommit(t *testing.T, s *Store, rev Revision) Revision {
	t.Helper()
	r, err := s.Commit(rev)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	return r
}

// 历史查询不得用未来提交修订: a correction committed later must not leak
// into a query whose asOfSeq predates it.
func TestHistoricalQueryIgnoresFutureCommits(t *testing.T) {
	s := NewStore()
	v1 := mustCommit(t, s, Revision{Key: "k", ValidFrom: day(0), ValidTo: day(10), Decision: "allow", Source: "policy-v1"})
	v2 := mustCommit(t, s, Revision{Key: "k", ValidFrom: day(0), ValidTo: day(10), Decision: "deny", Source: "policy-v2-correction"})

	hit, ok := s.Query("k", day(5), v1.Seq)
	if !ok || !hit.Active {
		t.Fatalf("asOf=v1: want active hit, got %+v ok=%v", hit, ok)
	}
	if hit.Revision.Seq != v1.Seq || hit.Revision.Decision != "allow" || hit.Revision.Source != "policy-v1" {
		t.Fatalf("asOf=v1: hit version %d, want %d (%+v)", hit.Revision.Seq, v1.Seq, hit.Revision)
	}

	hit, ok = s.Query("k", day(5), v2.Seq)
	if !ok || hit.Revision.Seq != v2.Seq || hit.Revision.Decision != "deny" {
		t.Fatalf("asOf=v2: want correction v2, got %+v", hit)
	}
}

// 撤回记录仍保留来源: a retraction shadows the layer going forward, but
// the retracted record stays in history with its original source, and the
// retraction itself carries its own provenance.
func TestRetractionRetainsProvenance(t *testing.T) {
	s := NewStore()
	v1 := mustCommit(t, s, Revision{Key: "k", ValidFrom: day(0), ValidTo: day(10), Decision: "allow", Source: "issuer-A"})
	r1, err := s.Retract("k", day(0), "auditor-B")
	if err != nil {
		t.Fatalf("Retract: %v", err)
	}

	// After the retraction the layer decides "inactive", and the hit
	// version is the retraction with its own source.
	hit, ok := s.Query("k", day(5), r1.Seq)
	if !ok {
		t.Fatal("asOf=retract: want a hit (the retraction layer)")
	}
	if hit.Active || hit.Revision.Seq != r1.Seq || hit.Revision.Source != "auditor-B" {
		t.Fatalf("asOf=retract: got %+v", hit)
	}

	// The retracted record is still reachable historically, source intact.
	hit, ok = s.Query("k", day(5), v1.Seq)
	if !ok || !hit.Active || hit.Revision.Source != "issuer-A" || hit.Revision.Decision != "allow" {
		t.Fatalf("historical: got %+v ok=%v", hit, ok)
	}

	// The raw log keeps both records.
	if got := len(s.Revisions("k")); got != 2 {
		t.Fatalf("history length = %d, want 2", got)
	}
}

// 最近有效层决胜: among overlapping layers the one with the most recent
// ValidFrom wins, even if it is a retraction.
func TestMostRecentValidLayerWins(t *testing.T) {
	s := NewStore()
	mustCommit(t, s, Revision{Key: "k", ValidFrom: day(0), ValidTo: day(30), Decision: "allow", Source: "base"})
	recent := mustCommit(t, s, Revision{Key: "k", ValidFrom: day(10), ValidTo: day(20), Decision: "deny", Source: "override"})

	hit, ok := s.Query("k", day(15), recent.Seq)
	if !ok || hit.Revision.Seq != recent.Seq || hit.Revision.Decision != "deny" {
		t.Fatalf("day15: want override layer, got %+v ok=%v", hit, ok)
	}

	hit, ok = s.Query("k", day(25), recent.Seq)
	if !ok || hit.Revision.Decision != "allow" {
		t.Fatalf("day25: want base layer, got %+v ok=%v", hit, ok)
	}

	// A retraction of the recent layer shadows the base layer too.
	r, err := s.Retract("k", day(10), "auditor")
	if err != nil {
		t.Fatalf("Retract: %v", err)
	}
	hit, ok = s.Query("k", day(15), r.Seq)
	if !ok || hit.Active || hit.Revision.Seq != r.Seq {
		t.Fatalf("day15 after retract: want inactive retraction hit, got %+v ok=%v", hit, ok)
	}
}

func TestOpenEndedAndBoundary(t *testing.T) {
	s := NewStore()
	v := mustCommit(t, s, Revision{Key: "k", ValidFrom: day(0), Decision: "allow", Source: "open"})

	if _, ok := s.Query("k", day(10000), v.Seq); !ok {
		t.Fatal("open-ended layer should cover far-future valid time")
	}
	if _, ok := s.Query("k", day(-1), v.Seq); ok {
		t.Fatal("ValidFrom is inclusive; day(-1) must miss")
	}

	if _, err := s.Commit(Revision{Key: "k", ValidFrom: day(5), ValidTo: day(5)}); err == nil {
		t.Fatal("empty interval must be rejected")
	}
	if _, err := s.Commit(Revision{Key: "bad", ValidFrom: day(0), ValidTo: day(10), Retracted: true, Decision: "allow"}); err != nil {
		t.Fatalf("retraction commit: %v", err)
	}
	if got := s.Revisions("bad")[0].Decision; got != "" {
		t.Fatalf("retraction decision cleared, got %q", got)
	}
}

// 二维时间网格完整重算核对: random workloads are resolved by Store.Query
// and by BruteForce over every (validAt, asOfSeq) grid point; results must
// be identical, including the hit version.
func TestGridCrossCheckAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const keys = 6
	const commits = 400

	s := NewStore()
	sources := []string{"issuer-A", "issuer-B", "auditor", "sync-job"}
	decisions := []string{"allow", "deny"}
	for i := 0; i < commits; i++ {
		key := fmt.Sprintf("key-%d", rng.Intn(keys))
		from := day(rng.Intn(20))
		switch rng.Intn(5) {
		case 0: // retraction of an existing or empty layer
			if _, err := s.Retract(key, from, sources[rng.Intn(len(sources))]); err != nil {
				t.Fatalf("Retract: %v", err)
			}
		default:
			var to time.Time
			if rng.Intn(4) != 0 { // 3/4 bounded, 1/4 open-ended
				to = from.AddDate(0, 0, 1+rng.Intn(15))
			}
			mustCommit(t, s, Revision{
				Key:       key,
				ValidFrom: from,
				ValidTo:   to,
				Decision:  decisions[rng.Intn(len(decisions))],
				Source:    sources[rng.Intn(len(sources))],
			})
		}
	}

	// Grid axes: valid times sweep inside/outside every interval; the
	// tx-time axis sweeps every commit boundary plus "before anything".
	validAxis := []time.Time{day(-1)}
	for d := 0; d <= 36; d++ {
		validAxis = append(validAxis, day(d))
	}
	txAxis := make([]int64, 0, commits+1)
	txAxis = append(txAxis, 0)
	for seq := int64(1); seq <= s.seq; seq++ {
		txAxis = append(txAxis, seq)
	}

	checked := 0
	for keyIdx := 0; keyIdx < keys; keyIdx++ {
		key := fmt.Sprintf("key-%d", keyIdx)
		for _, validAt := range validAxis {
			for _, asOf := range txAxis {
				gotHit, gotOK := s.Query(key, validAt, asOf)
				wantHit, wantOK := BruteForce(s, key, validAt, asOf)
				if gotOK != wantOK {
					t.Fatalf("key=%s validAt=%s asOf=%d: ok %v vs brute %v",
						key, validAt, asOf, gotOK, wantOK)
				}
				if gotOK && gotHit != wantHit {
					t.Fatalf("key=%s validAt=%s asOf=%d: hit %+v vs brute %+v",
						key, validAt, asOf, gotHit, wantHit)
				}
				checked++
			}
		}
	}
	t.Logf("grid cross-check: %d (valid,tx) points x %d keys matched, %d commits",
		len(validAxis)*len(txAxis), keys, s.seq)
}
