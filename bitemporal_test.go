package bitemporal

import (
	"fmt"
	"math/rand"
	"testing"
)

// --- naive 2D grid reference model ---------------------------------------
//
// naiveGrid materializes the full (business time x commit time) plane by
// brute force: for every grid cell it replays every correction of every
// commit from scratch. It shares no code with DB and serves as the ground
// truth for the randomized comparison.

type naiveGrid struct {
	cells map[[2]int64]Result // key: [businessTime, commitTime]
}

func buildNaiveGrid(commits [][]Correction, maxBusiness int64, maxCommit int) *naiveGrid {
	g := &naiveGrid{cells: make(map[[2]int64]Result)}
	for b := int64(0); b < maxBusiness; b++ {
		for c := 0; c <= maxCommit; c++ {
			g.cells[[2]int64{b, int64(c)}] = naivePoint(commits, b, c)
		}
	}
	return g
}

// naivePoint answers one (business, commit) point by scanning everything.
func naivePoint(commits [][]Correction, business int64, commit int) Result {
	best := Result{}
	found := false
	for id, cs := range commits {
		commitID := id + 1
		if commitID > commit {
			break
		}
		for _, c := range cs {
			if c.From <= business && business < c.To {
				best = Result{Found: !c.Delete, Value: c.Value, CommitID: commitID}
				if c.Delete {
					best.Value = ""
				}
				found = true
			}
		}
	}
	if !found {
		return Result{}
	}
	return best
}

func (g *naiveGrid) at(business int64, commit int) Result {
	return g.cells[[2]int64{business, int64(commit)}]
}

// --- unit tests -----------------------------------------------------------

func mustCommit(t *testing.T, db *DB, cs []Correction) int {
	t.Helper()
	id, err := db.Commit(cs)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	return id
}

func TestCorrectionOverridesBusinessInterval(t *testing.T) {
	db := New()
	c1 := mustCommit(t, db, []Correction{{Key: "a", From: 0, To: 10, Value: "v1"}})
	c2 := mustCommit(t, db, []Correction{{Key: "a", From: 3, To: 6, Value: "v2"}})

	cases := []struct {
		business int64
		want     string
		commitID int
	}{
		{0, "v1", c1}, {2, "v1", c1},
		{3, "v2", c2}, {5, "v2", c2},
		{6, "v1", c1}, {9, "v1", c1},
	}
	for _, tc := range cases {
		got := db.Get("a", tc.business, c2)
		if !got.Found || got.Value != tc.want || got.CommitID != tc.commitID {
			t.Errorf("Get(a, %d, %d) = %+v, want value %q from commit %d",
				tc.business, c2, got, tc.want, tc.commitID)
		}
	}
}

func TestHalfOpenBoundaries(t *testing.T) {
	db := New()
	c1 := mustCommit(t, db, []Correction{{Key: "a", From: 5, To: 8, Value: "v"}})
	if got := db.Get("a", 4, c1); got.Found {
		t.Errorf("business=4 (before From) should not be found, got %+v", got)
	}
	if got := db.Get("a", 8, c1); got.Found {
		t.Errorf("business=8 (== To, exclusive) should not be found, got %+v", got)
	}
	if got := db.Get("a", 5, c1); !got.Found {
		t.Errorf("business=5 (== From, inclusive) should be found")
	}
}

func TestDeleteHasValidityInterval(t *testing.T) {
	db := New()
	c1 := mustCommit(t, db, []Correction{{Key: "a", From: 0, To: 10, Value: "v1"}})
	c2 := mustCommit(t, db, []Correction{{Key: "a", From: 2, To: 4, Delete: true}})

	if got := db.Get("a", 3, c2); got.Found || got.CommitID != c2 {
		t.Errorf("deleted point: got %+v, want Found=false with CommitID=%d", got, c2)
	}
	if got := db.Get("a", 4, c2); !got.Found || got.Value != "v1" {
		t.Errorf("outside tombstone interval: got %+v, want v1", got)
	}
	// The tombstone did not exist yet at commit c1.
	if got := db.Get("a", 3, c1); !got.Found || got.Value != "v1" || got.CommitID != c1 {
		t.Errorf("before delete commit: got %+v, want v1 from commit %d", got, c1)
	}
}

func TestCommitTimeTravel(t *testing.T) {
	db := New()
	c1 := mustCommit(t, db, []Correction{{Key: "a", From: 0, To: 10, Value: "old"}})
	c2 := mustCommit(t, db, []Correction{{Key: "a", From: 0, To: 10, Value: "new"}})

	if got := db.Get("a", 5, c1); got.Value != "old" || got.CommitID != c1 {
		t.Errorf("as of commit %d: got %+v, want old", c1, got)
	}
	if got := db.Get("a", 5, c2); got.Value != "new" || got.CommitID != c2 {
		t.Errorf("as of commit %d: got %+v, want new", c2, got)
	}
	if got := db.Get("a", 5, 0); got.Found {
		t.Errorf("commit time 0 (before any commit): got %+v, want not found", got)
	}
}

func TestEmptyIntervalRejected(t *testing.T) {
	db := New()
	if _, err := db.Commit([]Correction{{Key: "a", From: 5, To: 5}}); err != ErrEmptyInterval {
		t.Errorf("got %v, want ErrEmptyInterval", err)
	}
	if _, err := db.Commit([]Correction{{Key: "a", From: 6, To: 5}}); err != ErrEmptyInterval {
		t.Errorf("got %v, want ErrEmptyInterval", err)
	}
}

func TestSameCommitLaterCorrectionWins(t *testing.T) {
	db := New()
	c1 := mustCommit(t, db, []Correction{
		{Key: "a", From: 0, To: 10, Value: "first"},
		{Key: "a", From: 0, To: 10, Value: "second"},
	})
	if got := db.Get("a", 5, c1); got.Value != "second" {
		t.Errorf("got %+v, want second", got)
	}
}

// --- randomized comparison against the naive grid -------------------------

func TestRandomizedAgainstNaiveGrid(t *testing.T) {
	const (
		trials      = 200
		maxBusiness = 40
		maxCommits  = 25
	)
	keys := []string{"alpha", "beta", "gamma", "delta"}

	for trial := 0; trial < trials; trial++ {
		rng := rand.New(rand.NewSource(int64(trial)))
		db := New()
		var commits [][]Correction
		nCommits := 1 + rng.Intn(maxCommits)
		for i := 0; i < nCommits; i++ {
			var cs []Correction
			for j := 0; j < 1+rng.Intn(4); j++ {
				from := rng.Int63n(maxBusiness - 1)
				to := from + 1 + rng.Int63n(maxBusiness-1-from)
				c := Correction{Key: keys[rng.Intn(len(keys))], From: from, To: to}
				if rng.Intn(4) == 0 {
					c.Delete = true
				} else {
					c.Value = fmt.Sprintf("t%d-c%d-v%d", trial, i, j)
				}
				cs = append(cs, c)
			}
			if _, err := db.Commit(cs); err != nil {
				t.Fatalf("trial %d: Commit: %v", trial, err)
			}
			commits = append(commits, cs)
		}

		for _, key := range keys {
			grid := buildNaiveGrid(filterByKey(commits, key), maxBusiness, nCommits)
			for b := int64(0); b < maxBusiness; b++ {
				for c := 0; c <= nCommits; c++ {
					want := grid.at(b, c)
					got := db.Get(key, b, c)
					if got != want {
						t.Fatalf("trial %d key %s Get(%d, %d) = %+v, naive grid says %+v",
							trial, key, b, c, got, want)
					}
				}
			}
		}
	}
}

func filterByKey(commits [][]Correction, key string) [][]Correction {
	out := make([][]Correction, len(commits))
	for i, cs := range commits {
		for _, c := range cs {
			if c.Key == key {
				out[i] = append(out[i], c)
			}
		}
	}
	return out
}
