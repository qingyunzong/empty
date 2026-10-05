package main

import (
	"fmt"
	"sort"
	"strings"
)

// sortByID returns a copy of rules ordered by ID (byte-wise), which
// defines the tie-break order used for equal-size subsets.
func sortByID(rules []Rule) []Rule {
	out := make([]Rule, len(rules))
	copy(out, rules)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// subsetIDs returns the IDs of rules selected by indices, in order.
func subsetIDs(rules []Rule, idx []int) []string {
	ids := make([]string, len(idx))
	for i, j := range idx {
		ids[i] = rules[j].ID
	}
	return ids
}

// selectRules returns the rules at the given indices.
func selectRules(rules []Rule, idx []int) []Rule {
	out := make([]Rule, len(idx))
	for i, j := range idx {
		out[i] = rules[j]
	}
	return out
}

// MinSubset finds the minimum-cardinality subset of rules that still
// proves denial of a request for value v. Among equal-size subsets it
// returns the one whose sorted ID list is lexicographically smallest
// ("same size, ID order"). It returns ok=false if no subset — not even
// the full rule set — denies the request.
//
// The search is exhaustive: subsets are enumerated in increasing size,
// and within one size in lexicographic ID order, so the first denying
// subset found is the unique answer.
func MinSubset(rules []Rule, v int) (subset []Rule, ok bool) {
	sorted := sortByID(rules)
	n := len(sorted)
	for k := 0; k <= n; k++ {
		var found []int
		combinations(n, k, func(comb []int) bool {
			if Denies(selectRules(sorted, comb), v) {
				found = append([]int(nil), comb...)
				return false // stop enumerating this size
			}
			return true
		})
		if found != nil {
			return selectRules(sorted, found), true
		}
	}
	return nil, false
}

// combinations calls visit for every k-combination of {0..n-1} in
// lexicographic order, stopping early when visit returns false.
func combinations(n, k int, visit func(comb []int) bool) {
	if k < 0 || k > n {
		return
	}
	comb := make([]int, k)
	for i := range comb {
		comb[i] = i
	}
	for {
		if !visit(comb) {
			return
		}
		i := k - 1
		for i >= 0 && comb[i] == n-k+i {
			i--
		}
		if i < 0 {
			return
		}
		comb[i]++
		for j := i + 1; j < k; j++ {
			comb[j] = comb[j-1] + 1
		}
	}
}

// idListLess compares two sorted ID lists lexicographically.
func idListLess(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// VerifyMinimal independently checks that subset is the correct answer
// for (rules, v): the subset itself denies, no strictly smaller subset
// denies, and no equal-size subset with a lexicographically smaller
// sorted ID list denies. It uses bitmask enumeration, a code path
// independent from MinSubset's combination walk, and is exhaustive
// over all 2^n subsets.
func VerifyMinimal(rules []Rule, v int, subset []Rule) error {
	sorted := sortByID(rules)
	n := len(sorted)
	if n > 62 {
		return fmt.Errorf("too many rules for bitmask verification: %d", n)
	}
	if !Denies(subset, v) {
		return fmt.Errorf("subset {%s} does not deny %d",
			strings.Join(ruleIDs(subset), ","), v)
	}
	want := sortByID(subset)
	wantIDs := ruleIDs(want)
	k := len(subset)
	for mask := 0; mask < 1<<n; mask++ {
		sz := popcount(mask)
		if sz > k {
			continue
		}
		cand := make([]Rule, 0, sz)
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				cand = append(cand, sorted[i])
			}
		}
		if !Denies(cand, v) {
			continue
		}
		candIDs := ruleIDs(cand) // already ID-sorted
		if sz < k {
			return fmt.Errorf("smaller denying subset {%s} of size %d exists",
				strings.Join(candIDs, ","), sz)
		}
		if idListLess(candIDs, wantIDs) {
			return fmt.Errorf("equal-size denying subset {%s} precedes {%s} in ID order",
				strings.Join(candIDs, ","), strings.Join(wantIDs, ","))
		}
	}
	return nil
}

func ruleIDs(rules []Rule) []string {
	ids := make([]string, len(rules))
	for i, r := range rules {
		ids[i] = r.ID
	}
	return ids
}

func popcount(x int) int {
	c := 0
	for x != 0 {
		x &= x - 1
		c++
	}
	return c
}
