package seqperiods

// This file holds the O(n^2) reference implementation. It scans every
// candidate period and every pair of positions directly on a plain slice,
// and is used to cross-check the hash-based Sequence on short inputs.

// BruteIsPeriod reports whether p is a period of a: a[i] == a[i+p] for
// all i with i+p < len(a). Every p >= len(a) is trivially a period.
func BruteIsPeriod(a []int64, p int) bool {
	_, _, bad := BruteFirstMismatch(a, p)
	return !bad
}

// BruteFirstMismatch returns the first pair (i, i+p) with a[i] != a[i+p];
// the bool is false when p is a period of a.
func BruteFirstMismatch(a []int64, p int) (i, j int, ok bool) {
	if p < 1 {
		panic("seqperiods: period must be positive")
	}
	for i = 0; i+p < len(a); i++ {
		if a[i] != a[i+p] {
			return i, i + p, true
		}
	}
	return 0, 0, false
}

// BrutePeriods returns every period p in [1, len(a)] in increasing order.
func BrutePeriods(a []int64) []int {
	var out []int
	for p := 1; p <= len(a); p++ {
		if BruteIsPeriod(a, p) {
			out = append(out, p)
		}
	}
	return out
}

// BruteMinPeriod returns the smallest period of a, or 0 if a is empty.
func BruteMinPeriod(a []int64) int {
	for p := 1; p <= len(a); p++ {
		if BruteIsPeriod(a, p) {
			return p
		}
	}
	return 0
}
