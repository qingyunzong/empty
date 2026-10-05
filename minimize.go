package main

// SizeStats aggregates verdicts for all subsequences of one size.
type SizeStats struct {
	Size    int
	Total   int
	Legal   int
	Failing int
}

// Result is the outcome of the minimization search.
type Result struct {
	Found         bool
	Witness       []int // one minimal failing subsequence (event indices)
	MinimalSize   int
	MinimalCount  int // how many failing subsequences exist at MinimalSize
	LegalBelowMin int // legal subsequences smaller than MinimalSize, all passing
	Stats         []SizeStats
}

// combinations calls yield for every k-element subset of {0..n-1},
// in lexicographic order, stopping early if yield returns false.
func combinations(n, k int, yield func([]int) bool) {
	comb := make([]int, k)
	var rec func(start, pos int) bool
	rec = func(start, pos int) bool {
		if pos == k {
			cp := make([]int, k)
			copy(cp, comb)
			return yield(cp)
		}
		for i := start; i <= n-k+pos; i++ {
			comb[pos] = i
			if !rec(i+1, pos+1) {
				return false
			}
		}
		return true
	}
	rec(0, 0)
}

// Minimize enumerates subsequences by increasing size and returns the first
// (and count of all) failing subsequences at the minimal size. Because every
// smaller subsequence is checked first, the result is provably minimal.
func Minimize(s *Scenario) *Result {
	n := len(s.Events)
	res := &Result{MinimalSize: -1}
	for k := 0; k <= n; k++ {
		st := SizeStats{Size: k}
		combinations(n, k, func(comb []int) bool {
			st.Total++
			fails, tr := s.fails(comb)
			if !tr.legal {
				return true
			}
			st.Legal++
			if fails {
				st.Failing++
				if !res.Found {
					res.Found = true
					res.Witness = comb
				}
			}
			return true
		})
		res.Stats = append(res.Stats, st)
		if st.Failing > 0 {
			res.MinimalSize = k
			res.MinimalCount = st.Failing
			for _, prev := range res.Stats[:len(res.Stats)-1] {
				res.LegalBelowMin += prev.Legal
			}
			return res
		}
	}
	return res
}

// Row is the full-detection evidence for a single subsequence.
type Row struct {
	Indices []int
	Legal   bool
	Failing bool
	Note    string
}

// Enumerate checks every subsequence (including the empty one) and returns
// one evidence row each, ordered by size then lexicographically.
func Enumerate(s *Scenario) []Row {
	n := len(s.Events)
	var rows []Row
	for k := 0; k <= n; k++ {
		combinations(n, k, func(comb []int) bool {
			fails, tr := s.fails(comb)
			row := Row{Indices: comb, Legal: tr.legal, Failing: fails}
			switch {
			case !tr.legal:
				row.Note = "illegal: " + tr.violation
			case fails:
				row.Note = "FAIL: victim reads a declared bad writer"
			default:
				row.Note = "pass"
			}
			rows = append(rows, row)
			return true
		})
	}
	return rows
}
