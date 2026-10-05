package bitemp

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

func TestBasicPutAndCommitTimeVisibility(t *testing.T) {
	s := NewStore()
	if err := s.AddCommit("c1", 10, []Correction{{Key: "k", ValidFrom: 0, ValidTo: 100, Value: "v1"}}); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.Query("k", 50, 9); ok {
		t.Fatal("value must not be visible before its commit time")
	}
	got, id, ok := s.Query("k", 50, 10)
	if !ok || got != "v1" || id != "c1" {
		t.Fatalf("got (%q,%q,%v), want (v1,c1,true)", got, id, ok)
	}
}

func TestCorrectionKeepsCommitTimeHistory(t *testing.T) {
	s := NewStore()
	mustCommit(t, s, "c1", 10, Correction{Key: "k", ValidFrom: 0, ValidTo: 100, Value: "old"})
	mustCommit(t, s, "c2", 20, Correction{Key: "k", ValidFrom: 40, ValidTo: 60, Value: "new"})

	// As of the first commit the old value is still everywhere.
	if got, id, ok := s.Query("k", 50, 15); !ok || got != "old" || id != "c1" {
		t.Fatalf("as-of c1: got (%q,%q,%v)", got, id, ok)
	}
	// After c2 the corrected range shows the new value, sourced from c2.
	if got, id, ok := s.Query("k", 50, 20); !ok || got != "new" || id != "c2" {
		t.Fatalf("after c2: got (%q,%q,%v)", got, id, ok)
	}
	// Outside the corrected range the old value remains.
	if got, id, ok := s.Query("k", 30, 20); !ok || got != "old" || id != "c1" {
		t.Fatalf("outside correction: got (%q,%q,%v)", got, id, ok)
	}
}

func TestHalfOpenInterval(t *testing.T) {
	s := NewStore()
	mustCommit(t, s, "c1", 1, Correction{Key: "k", ValidFrom: 10, ValidTo: 20, Value: "x"})
	if _, _, ok := s.Query("k", 9, 1); ok {
		t.Fatal("9 must be outside [10,20)")
	}
	if _, _, ok := s.Query("k", 20, 1); ok {
		t.Fatal("20 must be excluded from [10,20)")
	}
	if _, _, ok := s.Query("k", 10, 1); !ok {
		t.Fatal("10 must be included in [10,20)")
	}
}

func TestDeleteHasValidInterval(t *testing.T) {
	s := NewStore()
	mustCommit(t, s, "c1", 10, Correction{Key: "k", ValidFrom: 0, ValidTo: 100, Value: "v"})
	mustCommit(t, s, "c2", 20, Correction{Key: "k", ValidFrom: 30, ValidTo: 70, Delete: true})

	// Inside the delete's valid interval, after its commit: gone.
	if _, _, ok := s.Query("k", 50, 20); ok {
		t.Fatal("deleted range must not return a value")
	}
	// Same business time, but as of before the delete commit: still there.
	if got, _, ok := s.Query("k", 50, 19); !ok || got != "v" {
		t.Fatalf("delete must not rewrite commit-time history: got (%q,%v)", got, ok)
	}
	// Outside the delete's valid interval the value survives.
	if got, _, ok := s.Query("k", 80, 20); !ok || got != "v" {
		t.Fatalf("outside delete interval: got (%q,%v)", got, ok)
	}
}

func TestLaterCorrectionInSameCommitWins(t *testing.T) {
	s := NewStore()
	mustCommit(t, s, "c1", 5,
		Correction{Key: "k", ValidFrom: 0, ValidTo: 10, Value: "first"},
		Correction{Key: "k", ValidFrom: 5, ValidTo: 15, Value: "second"},
	)
	if got, _, ok := s.Query("k", 7, 5); !ok || got != "second" {
		t.Fatalf("overlap inside one commit: got (%q,%v)", got, ok)
	}
	if got, _, ok := s.Query("k", 2, 5); !ok || got != "first" {
		t.Fatalf("non-overlap inside one commit: got (%q,%v)", got, ok)
	}
}

func TestRejectedInputs(t *testing.T) {
	s := NewStore()
	if err := s.AddCommit("bad", 1, []Correction{{Key: "k", ValidFrom: 5, ValidTo: 5}}); err != ErrEmptyInterval {
		t.Fatalf("empty interval: got %v", err)
	}
	mustCommit(t, s, "c1", 10)
	if err := s.AddCommit("c2", 9, nil); err == nil {
		t.Fatal("backwards commit time must be rejected")
	}
}

func mustCommit(t *testing.T, s *Store, id string, ct int64, cs ...Correction) {
	t.Helper()
	if err := s.AddCommit(id, ct, cs); err != nil {
		t.Fatalf("AddCommit(%q): %v", id, err)
	}
}

// --- naive 2D grid oracle ---

// naiveInterval is one piece of the current best knowledge for a key,
// produced by replaying commits with split-and-overwrite semantics.
type naiveInterval struct {
	from, to int64
	value    string
	deleted  bool
	commitID string
}

// naiveGrid replays commits and snapshots the full state after each one,
// yielding a grid indexed by [key][commitSeq][validTime].
type naiveGrid struct {
	snapshots []map[string][]naiveInterval // indexed by commit seq-1
	commits   []naiveCommit
}

type naiveCommit struct {
	id   string
	time int64
}

func (g *naiveGrid) addCommit(id string, ct int64, cs []Correction) {
	state := map[string][]naiveInterval{}
	if n := len(g.snapshots); n > 0 {
		for k, ivs := range g.snapshots[n-1] {
			state[k] = append([]naiveInterval(nil), ivs...)
		}
	}
	for _, c := range cs {
		state[c.Key] = overwrite(state[c.Key], c, id)
	}
	g.snapshots = append(g.snapshots, state)
	g.commits = append(g.commits, naiveCommit{id: id, time: ct})
}

func overwrite(ivs []naiveInterval, c Correction, commitID string) []naiveInterval {
	out := make([]naiveInterval, 0, len(ivs)+1)
	for _, iv := range ivs {
		if iv.to <= c.ValidFrom || iv.from >= c.ValidTo {
			out = append(out, iv)
			continue
		}
		if iv.from < c.ValidFrom {
			out = append(out, naiveInterval{from: iv.from, to: c.ValidFrom, value: iv.value, deleted: iv.deleted, commitID: iv.commitID})
		}
		if iv.to > c.ValidTo {
			out = append(out, naiveInterval{from: c.ValidTo, to: iv.to, value: iv.value, deleted: iv.deleted, commitID: iv.commitID})
		}
	}
	return append(out, naiveInterval{from: c.ValidFrom, to: c.ValidTo, value: c.Value, deleted: c.Delete, commitID: commitID})
}

// at resolves (validTime, commitTime) on the grid.
func (g *naiveGrid) at(key string, validTime, commitTime int64) (string, string, bool) {
	seq := sort.Search(len(g.commits), func(i int) bool { return g.commits[i].time > commitTime })
	if seq == 0 {
		return "", "", false
	}
	for _, iv := range g.snapshots[seq-1][key] {
		if iv.from <= validTime && validTime < iv.to {
			if iv.deleted {
				return "", "", false
			}
			return iv.value, iv.commitID, true
		}
	}
	return "", "", false
}

func TestRandomizedAgainstNaiveGrid(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 7, 42, 99, 2024, 31337} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			s := NewStore()
			grid := &naiveGrid{}

			keys := []string{"alpha", "beta", "gamma", "delta"}
			const maxValid = 40
			commitTime := int64(0)
			nCommits := 5 + rng.Intn(15)
			for i := 0; i < nCommits; i++ {
				commitTime += int64(rng.Intn(4)) // non-decreasing, may repeat
				id := fmt.Sprintf("commit-%d-%d", seed, i)
				var cs []Correction
				for j := 0; j < rng.Intn(5); j++ {
					from := int64(rng.Intn(maxValid))
					to := from + 1 + int64(rng.Intn(maxValid/2))
					c := Correction{
						Key:       keys[rng.Intn(len(keys))],
						ValidFrom: from,
						ValidTo:   to,
						Value:     fmt.Sprintf("v%d-%d", i, j),
						Delete:    rng.Intn(4) == 0,
					}
					cs = append(cs, c)
				}
				if err := s.AddCommit(id, commitTime, cs); err != nil {
					t.Fatalf("AddCommit: %v", err)
				}
				grid.addCommit(id, commitTime, cs)
			}

			allKeys := append(append([]string(nil), keys...), "never-touched")
			for _, key := range allKeys {
				for vt := int64(-1); vt <= maxValid+1; vt++ {
					for ct := int64(-1); ct <= commitTime+1; ct++ {
						gv, gid, gok := s.Query(key, vt, ct)
						nv, nid, nok := grid.at(key, vt, ct)
						if gv != nv || gid != nid || gok != nok {
							t.Fatalf("key=%q vt=%d ct=%d: store=(%q,%q,%v) naive=(%q,%q,%v)",
								key, vt, ct, gv, gid, gok, nv, nid, nok)
						}
					}
				}
			}
		})
	}
}
