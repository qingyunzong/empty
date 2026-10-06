package repsim

import (
	"sort"
	"strings"
)

// Membership describes the voter configuration that arbitrates commits.
// A non-nil New means the cluster is in a joint configuration: an entry
// may commit only after reaching a majority of Old AND a majority of New.
type Membership struct {
	Old []string
	New []string // nil: single (non-joint) configuration
}

// Joint reports whether this is a joint (transitional) configuration.
func (m Membership) Joint() bool { return m.New != nil }

func majority(n int) int { return n/2 + 1 }

func countIn(set, voters []string) int {
	n := 0
	for _, v := range voters {
		for _, s := range set {
			if v == s {
				n++
				break
			}
		}
	}
	return n
}

func intersect(a, b []string) []string {
	var out []string
	for _, x := range a {
		for _, y := range b {
			if x == y {
				out = append(out, x)
				break
			}
		}
	}
	return out
}

// QuorumSatisfied reports whether voters form a majority of every
// configuration in the membership (both sides when joint).
func (m Membership) QuorumSatisfied(voters []string) bool {
	if countIn(m.Old, voters) < majority(len(m.Old)) {
		return false
	}
	if m.Joint() && countIn(m.New, voters) < majority(len(m.New)) {
		return false
	}
	return true
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func keyOf(members []string) string { return strings.Join(sortedCopy(members), ",") }

func union(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range append(append([]string(nil), a...), b...) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}
