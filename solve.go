package main

import (
	"fmt"
	"sort"
)

// Solve exhaustively evaluates every one of the 2^N subsets of rules
// (N <= 18) and returns a minimum-cardinality subset that still rejects q.
// Ties are broken by ID order: among equal-size rejecting subsets the one
// whose sorted ID list is lexicographically smallest wins.
//
// The boolean reports whether any rejecting subset exists (equivalently,
// whether the full rule set rejects q).
func Solve(rules []Rule, q int) ([]Rule, bool) {
	n := len(rules)
	var best []int // indices into rules
	total := 1 << n
	for mask := 0; mask < total; mask++ {
		sub := make([]Rule, 0, n)
		idx := make([]int, 0, n)
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				sub = append(sub, rules[i])
				idx = append(idx, i)
			}
		}
		if !Rejected(sub, q) {
			continue
		}
		if best == nil || len(idx) < len(best) || (len(idx) == len(best) && lessByID(rules, idx, best)) {
			best = idx
		}
	}
	if best == nil {
		return nil, false
	}
	out := make([]Rule, len(best))
	for i, ix := range best {
		out[i] = rules[ix]
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, true
}

// lessByID compares two equal-length index lists by their sorted ID lists.
func lessByID(rules []Rule, a, b []int) bool {
	ia := sortedIDs(rules, a)
	ib := sortedIDs(rules, b)
	for i := range ia {
		if ia[i] != ib[i] {
			return ia[i] < ib[i]
		}
	}
	return false
}

func sortedIDs(rules []Rule, idx []int) []int {
	ids := make([]int, len(idx))
	for i, ix := range idx {
		ids[i] = rules[ix].ID
	}
	sort.Ints(ids)
	return ids
}

// VerifyMinimality independently confirms that no subset strictly smaller
// than k rejects q. It uses a recursive combination generator and the
// independent evaluator RejectedIndependent — a separate code path from
// Solve's bitmask scan — so a bug in one cannot silently validate the other.
// It returns the number of subsets checked and whether the claim holds.
func VerifyMinimality(rules []Rule, q, k int) (checked int, ok bool) {
	n := len(rules)
	ok = true
	for size := 0; size < k && ok; size++ {
		combine(n, size, func(idx []int) {
			if !ok {
				return
			}
			sub := make([]Rule, len(idx))
			for i, ix := range idx {
				sub[i] = rules[ix]
			}
			checked++
			if RejectedIndependent(sub, q) {
				ok = false
			}
		})
	}
	return checked, ok
}

// combine calls f for every size-element combination of {0..n-1}.
func combine(n, size int, f func([]int)) {
	idx := make([]int, 0, size)
	var rec func(start int)
	rec = func(start int) {
		if len(idx) == size {
			f(append([]int(nil), idx...))
			return
		}
		for i := start; i < n; i++ {
			idx = append(idx, i)
			rec(i + 1)
			idx = idx[:len(idx)-1]
		}
	}
	rec(0)
}

// Explain renders a human-readable justification of why subset rejects q.
func Explain(subset []Rule, q int) string {
	maxAllow, maxDeny := -1, -1
	var allowRule, denyRule Rule
	for _, r := range subset {
		if !r.Matches(q) {
			continue
		}
		if r.Act == Allow && r.Layer > maxAllow {
			maxAllow, allowRule = r.Layer, r
		}
		if r.Act == Deny && r.Layer > maxDeny {
			maxDeny, denyRule = r.Layer, r
		}
	}
	return fmt.Sprintf(
		"request %d is granted by allow id=%d at layer %d, and the grant is revoked by deny id=%d at layer %d (deny-priority: layer %d >= layer %d)",
		q, allowRule.ID, maxAllow, denyRule.ID, maxDeny, maxDeny, maxAllow)
}
