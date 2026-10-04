package arb

import "testing"

func mustConfig(t *testing.T, weights map[string]int) Config {
	t.Helper()
	c, err := NewConfig(weights)
	if err != nil {
		t.Fatalf("NewConfig(%v): %v", weights, err)
	}
	return c
}

func TestStrictWeightedMajority(t *testing.T) {
	c := mustConfig(t, map[string]int{"a": 2, "b": 1, "c": 1}) // total 4, quorum 3
	if got, want := c.Quorum(), 3; got != want {
		t.Fatalf("Quorum()=%d, want %d", got, want)
	}
	if c.IsQuorum([]string{"b", "c"}) { // weight 2 is exactly half, not a majority
		t.Fatal("weight 2 of 4 must not be a quorum")
	}
	if !c.IsQuorum([]string{"a", "b"}) { // weight 3
		t.Fatal("weight 3 of 4 must be a quorum")
	}
	if !c.IsQuorum([]string{"a", "a", "b"}) { // duplicate ids count once
		t.Fatal("duplicate ids must count once: a,b is a quorum")
	}
	if c.IsQuorum([]string{"a", "zz"}) { // unknown voter ignored
		t.Fatal("unknown voters must not count")
	}
}

// subsets enumerates all subsets of ids as voter slices.
func subsets(ids []string) [][]string {
	var out [][]string
	n := len(ids)
	for mask := 0; mask < 1<<n; mask++ {
		var s []string
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				s = append(s, ids[i])
			}
		}
		out = append(out, s)
	}
	return out
}

func intersect(a, b []string) bool {
	set := map[string]bool{}
	for _, x := range a {
		set[x] = true
	}
	for _, y := range b {
		if set[y] {
			return true
		}
	}
	return false
}

// TestQuorumIntersectionExhaustive enumerates every weighted config of
// n voters with weights in 1..3 and verifies that any two quorums
// intersect: the foundation of "no two conflicting commits".
func TestQuorumIntersectionExhaustive(t *testing.T) {
	ids := []string{"n0", "n1", "n2", "n3"}
	for w0 := 1; w0 <= 3; w0++ {
		for w1 := 1; w1 <= 3; w1++ {
			for w2 := 1; w2 <= 3; w2++ {
				for w3 := 1; w3 <= 3; w3++ {
					c := mustConfig(t, map[string]int{
						"n0": w0, "n1": w1, "n2": w2, "n3": w3})
					var quorums [][]string
					for _, s := range subsets(ids) {
						if c.IsQuorum(s) {
							quorums = append(quorums, s)
						}
					}
					for i := 0; i < len(quorums); i++ {
						for j := i; j < len(quorums); j++ {
							if !intersect(quorums[i], quorums[j]) {
								t.Fatalf("disjoint quorums %v and %v in %v",
									quorums[i], quorums[j], c.Weights)
							}
						}
					}
				}
			}
		}
	}
}

// TestJointQuorumIntersectionExhaustive verifies that any two voter
// sets that each satisfy BOTH configs (the joint commit rule)
// necessarily share a voter.
func TestJointQuorumIntersectionExhaustive(t *testing.T) {
	oldCfg := mustConfig(t, map[string]int{"a": 1, "b": 1, "c": 1})
	newCfg := mustConfig(t, map[string]int{"c": 2, "d": 1, "e": 1})
	ids := []string{"a", "b", "c", "d", "e"}
	var jointQuorums [][]string
	for _, s := range subsets(ids) {
		if oldCfg.IsQuorum(s) && newCfg.IsQuorum(s) {
			jointQuorums = append(jointQuorums, s)
		}
	}
	if len(jointQuorums) == 0 {
		t.Fatal("no joint quorums found")
	}
	for i := 0; i < len(jointQuorums); i++ {
		for j := i; j < len(jointQuorums); j++ {
			if !intersect(jointQuorums[i], jointQuorums[j]) {
				t.Fatalf("disjoint joint quorums %v and %v",
					jointQuorums[i], jointQuorums[j])
			}
		}
	}
}
