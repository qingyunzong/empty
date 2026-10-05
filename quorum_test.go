package quorum

import (
	"fmt"
	"math/rand"
	"testing"
)

func mustConfig(t *testing.T, weights map[Node]int) Config {
	t.Helper()
	c, err := NewConfig(weights)
	if err != nil {
		t.Fatalf("NewConfig(%v): %v", weights, err)
	}
	return c
}

func mustVote(t *testing.T, s *Simulator, n Node, value string) {
	t.Helper()
	if err := s.Vote(n, value); err != nil {
		t.Fatalf("Vote(%q, %q): %v", n, value, err)
	}
}

func TestNewConfigValidation(t *testing.T) {
	if _, err := NewConfig(nil); err == nil {
		t.Error("empty config: want error")
	}
	if _, err := NewConfig(map[Node]int{"a": 0}); err == nil {
		t.Error("zero weight: want error")
	}
	if _, err := NewConfig(map[Node]int{"a": -1}); err == nil {
		t.Error("negative weight: want error")
	}
}

func TestStrictMajorityWithWeights(t *testing.T) {
	c := mustConfig(t, map[Node]int{"a": 2, "b": 1, "c": 1}) // total 4
	if got, want := c.Majority(), 3; got != want {
		t.Errorf("Majority() = %d, want %d", got, want)
	}
	// Exactly half of the total weight is NOT a quorum.
	if ok, err := c.IsQuorum([]Node{"a"}); err != nil || ok {
		t.Errorf("IsQuorum({a}) = %v, %v; want false, nil (2*2 !> 4)", ok, err)
	}
	if ok, err := c.IsQuorum([]Node{"a", "b"}); err != nil || !ok {
		t.Errorf("IsQuorum({a,b}) = %v, %v; want true, nil (2*3 > 4)", ok, err)
	}
	// Even split of two equal voters is not a quorum.
	tie := mustConfig(t, map[Node]int{"a": 1, "b": 1})
	if ok, _ := tie.IsQuorum([]Node{"a"}); ok {
		t.Error("IsQuorum({a}) with total 2: want false (1*2 !> 2)")
	}
	if _, err := c.IsQuorum([]Node{"z"}); err == nil {
		t.Error("unknown voter: want error")
	}
	if _, err := c.IsQuorum([]Node{"a", "a"}); err == nil {
		t.Error("duplicate voter: want error")
	}
}

func TestJointRequiresBothConfigs(t *testing.T) {
	oldCfg := mustConfig(t, map[Node]int{"a": 1, "b": 1, "c": 1})
	newCfg := mustConfig(t, map[Node]int{"c": 1, "d": 1, "e": 1})
	s := NewSimulator(oldCfg, newCfg)
	if err := s.EnterJoint(); err != nil {
		t.Fatal(err)
	}
	// Old-config majority only: not enough in the joint phase.
	mustVote(t, s, "a", "v")
	mustVote(t, s, "b", "v")
	if _, ok := s.Commit("v"); ok {
		t.Fatal("joint commit with only an old-config quorum must fail")
	}
	// Add a new-config majority: now both configs have a quorum.
	mustVote(t, s, "d", "v")
	mustVote(t, s, "e", "v")
	ev, ok := s.Commit("v")
	if !ok {
		t.Fatal("joint commit with both quorums must succeed")
	}
	if ev.Old == nil || ev.New == nil {
		t.Fatalf("joint evidence must cover both configs: %v", ev)
	}
	t.Logf("evidence: %v", ev)
}

func TestEnterNewRequiresJointCommit(t *testing.T) {
	oldCfg := mustConfig(t, map[Node]int{"a": 1, "b": 1, "c": 1})
	newCfg := mustConfig(t, map[Node]int{"c": 1, "d": 1, "e": 1})
	s := NewSimulator(oldCfg, newCfg)
	if err := s.EnterNew(); err == nil {
		t.Error("EnterNew from old-only: want error")
	}
	if err := s.EnterJoint(); err != nil {
		t.Fatal(err)
	}
	if err := s.EnterNew(); err == nil {
		t.Error("EnterNew before any joint commit: want error")
	}
	mustVote(t, s, "a", "v")
	mustVote(t, s, "b", "v")
	mustVote(t, s, "d", "v")
	mustVote(t, s, "e", "v")
	if _, ok := s.Commit("v"); !ok {
		t.Fatal("joint commit must succeed")
	}
	if err := s.EnterNew(); err != nil {
		t.Errorf("EnterNew after joint commit: %v", err)
	}
	if got := s.Phase(); got != NewOnly {
		t.Errorf("Phase() = %s, want new-only", got)
	}
}

func TestConflictingCommitRejected(t *testing.T) {
	oldCfg := mustConfig(t, map[Node]int{"a": 1, "b": 1, "c": 1})
	newCfg := mustConfig(t, map[Node]int{"c": 1, "d": 1, "e": 1})
	s := NewSimulator(oldCfg, newCfg)
	mustVote(t, s, "a", "v1")
	mustVote(t, s, "b", "v1")
	if _, ok := s.Commit("v1"); !ok {
		t.Fatal("old-only commit of v1 must succeed")
	}
	// Only c is left in the old config; v2 can never reach an old majority.
	mustVote(t, s, "c", "v2")
	if _, ok := s.Commit("v2"); ok {
		t.Fatal("conflicting commit v2 must fail in old-only phase")
	}
	if err := s.EnterJoint(); err != nil {
		t.Fatal(err)
	}
	mustVote(t, s, "d", "v2")
	mustVote(t, s, "e", "v2")
	if _, ok := s.Commit("v2"); ok {
		t.Fatal("conflicting commit v2 must fail in joint phase (no old quorum)")
	}
	if c := Conflicts(s.Commits()); len(c) != 0 {
		t.Fatalf("unexpected conflicts: %v", c)
	}
}

func TestVoteOnce(t *testing.T) {
	s := NewSimulator(
		mustConfig(t, map[Node]int{"a": 1}),
		mustConfig(t, map[Node]int{"a": 1}),
	)
	mustVote(t, s, "a", "v1")
	if err := s.Vote("a", "v2"); err == nil {
		t.Error("second vote from the same node: want error")
	}
	if err := s.Vote("z", "v1"); err == nil {
		t.Error("vote from unknown node: want error")
	}
}

// --- Exhaustive enumeration over small configs ---------------------------

func allSubsets(nodes []Node) [][]Node {
	subsets := [][]Node{{}}
	for _, n := range nodes {
		for _, s := range subsets {
			subsets = append(subsets, append(append([]Node{}, s...), n))
		}
	}
	return subsets
}

func unionNodes(a, b Config) []Node {
	seen := map[Node]bool{}
	var out []Node
	for _, n := range append(a.Nodes(), b.Nodes()...) {
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

func intersect(a, b []Node) []Node {
	inB := map[Node]bool{}
	for _, n := range b {
		inB[n] = true
	}
	var out []Node
	for _, n := range a {
		if inB[n] {
			out = append(out, n)
		}
	}
	return out
}

// coLive reports whether commits in phases a and b can be gathering votes at
// the same time: only identical or adjacent phases, because the switch
// old-only -> joint -> new-only is ordered and new-only starts only after a
// joint commit.
func coLive(a, b Phase) bool {
	if a > b {
		a, b = b, a
	}
	return b-a <= 1
}

// TestExhaustiveNoConflictingCommits enumerates every voter subset of small
// configs and proves that any two quorums that can be live at the same time
// intersect. Since every node votes at most once, two commits with different
// values would need disjoint quorums, so no conflicting commits can exist.
func TestExhaustiveNoConflictingCommits(t *testing.T) {
	cases := []struct {
		name     string
		old, new map[Node]int
	}{
		{"uniform-3-3", map[Node]int{"a": 1, "b": 1, "c": 1}, map[Node]int{"c": 1, "d": 1, "e": 1}},
		{"uniform-2-3", map[Node]int{"a": 1, "b": 1}, map[Node]int{"b": 1, "c": 1, "d": 1}},
		{"weighted", map[Node]int{"a": 4, "b": 1, "c": 1}, map[Node]int{"b": 2, "c": 2, "d": 2}},
		{"weighted-shared-voter", map[Node]int{"a": 3, "b": 2, "c": 2}, map[Node]int{"c": 3, "d": 1, "e": 1}},
	}
	phases := []Phase{OldOnly, Joint, NewOnly}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			oldCfg := mustConfig(t, tc.old)
			newCfg := mustConfig(t, tc.new)
			subsets := allSubsets(unionNodes(oldCfg, newCfg))
			quorums := map[Phase][][]Node{}
			for _, p := range phases {
				for _, sub := range subsets {
					if Satisfies(p, oldCfg, newCfg, sub) {
						quorums[p] = append(quorums[p], sub)
					}
				}
			}
			checked := 0
			for _, p1 := range phases {
				for _, p2 := range phases {
					if !coLive(p1, p2) {
						continue
					}
					for _, q1 := range quorums[p1] {
						for _, q2 := range quorums[p2] {
							checked++
							if len(intersect(q1, q2)) == 0 {
								t.Errorf("disjoint quorums in co-live phases %s/%s: %v vs %v "+
									"-> conflicting commits possible", p1, p2, q1, q2)
							}
						}
					}
				}
			}
			t.Logf("checked %d quorum pairs across co-live phases: all intersect", checked)

			// The joint phase is necessary: old-only and new-only quorums
			// can be disjoint, so skipping the joint phase would allow two
			// conflicting commits.
			found := false
			for _, q1 := range quorums[OldOnly] {
				for _, q2 := range quorums[NewOnly] {
					if len(intersect(q1, q2)) == 0 {
						t.Logf("without the joint phase, disjoint quorums %v (old) and %v (new) could commit conflicting values", q1, q2)
						found = true
						break
					}
				}
				if found {
					break
				}
			}
			if !found {
				t.Error("expected disjoint old-only/new-only quorums to exist for these configs")
			}
		})
	}
}

// TestRandomizedNoConflicts runs randomized reconfiguration scenarios and
// verifies the commit log never contains two commits with different values.
func TestRandomizedNoConflicts(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	pool := []Node{"a", "b", "c", "d", "e"}
	for trial := 0; trial < 500; trial++ {
		randCfg := func() Config {
			w := map[Node]int{}
			for _, n := range pool {
				if rng.Intn(2) == 0 {
					w[n] = 1 + rng.Intn(3)
				}
			}
			if len(w) == 0 {
				w[pool[rng.Intn(len(pool))]] = 1
			}
			c, err := NewConfig(w)
			if err != nil {
				t.Fatal(err)
			}
			return c
		}
		s := NewSimulator(randCfg(), randCfg())
		for _, n := range pool {
			if rng.Intn(2) == 0 {
				continue
			}
			value := "x"
			if rng.Intn(2) == 0 {
				value = "y"
			}
			if err := s.Vote(n, value); err != nil {
				continue // node not in either config
			}
			switch rng.Intn(4) {
			case 0:
				_ = s.EnterJoint()
			case 1:
				_ = s.EnterNew()
			}
			s.Commit("x")
			s.Commit("y")
		}
		if c := Conflicts(s.Commits()); len(c) != 0 {
			t.Fatalf("trial %d: conflicting commits: %v", trial, c)
		}
	}
}

// ExampleSimulator runs a full reconfiguration and prints the voting
// evidence of every commit.
func ExampleSimulator() {
	oldCfg, _ := NewConfig(map[Node]int{"a": 1, "b": 1, "c": 1})
	newCfg, _ := NewConfig(map[Node]int{"c": 1, "d": 1, "e": 1})
	s := NewSimulator(oldCfg, newCfg)
	vote := func(n Node, v string) {
		if err := s.Vote(n, v); err != nil {
			panic(err)
		}
	}

	// Phase 1: old config only.
	vote("a", "v1")
	vote("b", "v1")
	_, ok := s.Commit("v1")
	fmt.Println("committed:", ok, s.Commits()[len(s.Commits())-1])

	// Phase 2: joint, both configs must agree.
	if err := s.EnterJoint(); err != nil {
		panic(err)
	}
	vote("c", "v1")
	vote("d", "v1")
	_, ok = s.Commit("v1")
	fmt.Println("committed:", ok, s.Commits()[len(s.Commits())-1])

	// Phase 3: switch complete, new config only.
	if err := s.EnterNew(); err != nil {
		panic(err)
	}
	vote("e", "v1")
	_, ok = s.Commit("v1")
	fmt.Println("committed:", ok, s.Commits()[len(s.Commits())-1])

	// Output:
	// committed: true commit value="v1" phase=old-only old{voters=[a b] weight=2 total=3 need>=2}
	// committed: true commit value="v1" phase=joint old{voters=[a b c] weight=3 total=3 need>=2} new{voters=[c d] weight=2 total=3 need>=2}
	// committed: true commit value="v1" phase=new-only new{voters=[c d e] weight=3 total=3 need>=2}
}
