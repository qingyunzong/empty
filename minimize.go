package main

// Check is one detection-evidence record: a candidate subsequence and verdicts.
type Check struct {
	Sub   []int
	Legal bool
	Fail  bool
}

// Evidence collects every candidate check performed, in order.
type Evidence struct {
	Checks []Check
}

func (e *Evidence) record(sub []int, legal, fail bool) {
	cp := make([]int, len(sub))
	copy(cp, sub)
	e.Checks = append(e.Checks, Check{Sub: cp, Legal: legal, Fail: fail})
}

// combinations calls fn for every k-combination of {0..n-1} in
// lexicographic order; returning false from fn stops iteration early.
func combinations(n, k int, fn func(combo []int) bool) {
	if k < 0 || k > n {
		return
	}
	combo := make([]int, k)
	for i := range combo {
		combo[i] = i
	}
	for {
		if !fn(combo) {
			return
		}
		// advance to next combination
		i := k - 1
		for i >= 0 && combo[i] == n-k+i {
			i--
		}
		if i < 0 {
			return
		}
		combo[i]++
		for j := i + 1; j < k; j++ {
			combo[j] = combo[j-1] + 1
		}
	}
}

// MinFailing finds a minimum-cardinality failing subsequence by testing
// candidates in increasing size order (1,2,...,n), lexicographic within a
// size. The first failing candidate found is therefore provably minimum.
// Every candidate tested is appended to ev (full detection evidence).
// Returns nil if no failing subsequence exists.
func MinFailing(s Scenario, ev *Evidence) []int {
	n := len(s.Events)
	for size := 1; size <= n; size++ {
		var found []int
		combinations(n, size, func(combo []int) bool {
			legal := s.Legal(combo)
			fail := legal && s.Fails(combo)
			ev.record(combo, legal, fail)
			if fail {
				found = make([]int, size)
				copy(found, combo)
				return false
			}
			return true
		})
		if found != nil {
			return found
		}
	}
	return nil
}

// EnumerateAll tests every one of the 2^n subsequences (including empty)
// and returns all failing ones plus the full evidence. Used to cross-check
// minimality on small examples.
func EnumerateAll(s Scenario, ev *Evidence) [][]int {
	n := len(s.Events)
	var failing [][]int
	total := 1 << uint(n)
	for mask := 0; mask < total; mask++ {
		var sub []int
		for i := 0; i < n; i++ {
			if mask&(1<<uint(i)) != 0 {
				sub = append(sub, i)
			}
		}
		legal := s.Legal(sub)
		fail := legal && s.Fails(sub)
		ev.record(sub, legal, fail)
		if fail {
			failing = append(failing, sub)
		}
	}
	return failing
}

// MinSize returns the minimum cardinality among subs, or -1 if empty.
func MinSize(subs [][]int) int {
	min := -1
	for _, sub := range subs {
		if min < 0 || len(sub) < min {
			min = len(sub)
		}
	}
	return min
}

// IsOneMinimal reports whether removing any single event from sub makes it
// non-failing (1-minimality), given that sub itself fails.
func IsOneMinimal(s Scenario, sub []int) bool {
	if !s.Fails(sub) {
		return false
	}
	for i := range sub {
		reduced := make([]int, 0, len(sub)-1)
		reduced = append(reduced, sub[:i]...)
		reduced = append(reduced, sub[i+1:]...)
		if s.Fails(reduced) {
			return false
		}
	}
	return true
}
