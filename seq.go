// Package seqlib maintains a finite integer sequence and answers period
// queries under point updates.
//
// A period p (1 <= p <= n) of the sequence a[0..n-1] requires
// a[i] == a[i+p] for every valid i. The length n does NOT need to be a
// multiple of p; p == n always holds vacuously.
package seqlib

// Seq is a mutable integer sequence with incremental period bookkeeping.
//
// bad[d] counts indices i with a[i] != a[i+d], so p is a period iff
// bad[p] == 0. Updates and queries are O(n); the structure is meant for
// correctness-critical use and is validated against a brute-force scan.
type Seq struct {
	a   []int64
	bad []int // bad[d] for 1 <= d < n; bad[0] unused
}

// New builds a Seq from a copy of a.
func New(a []int64) *Seq {
	s := &Seq{a: append([]int64(nil), a...)}
	n := len(a)
	s.bad = make([]int, n+1)
	for d := 1; d < n; d++ {
		for i := 0; i+d < n; i++ {
			if s.a[i] != s.a[i+d] {
				s.bad[d]++
			}
		}
	}
	return s
}

// Len returns the sequence length.
func (s *Seq) Len() int { return len(s.a) }

// At returns a[i].
func (s *Seq) At(i int) int64 { return s.a[i] }

// Set assigns a[i] = v and refreshes the mismatch counters.
func (s *Seq) Set(i int, v int64) {
	n := len(s.a)
	if i < 0 || i >= n {
		panic("seqlib: index out of range")
	}
	old := s.a[i]
	if old == v {
		return
	}
	for j := 0; j < n; j++ {
		if j == i {
			continue
		}
		d := i - j
		if d < 0 {
			d = -d
		}
		wasEq := old == s.a[j]
		isEq := v == s.a[j]
		switch {
		case wasEq && !isEq:
			s.bad[d]++
		case !wasEq && isEq:
			s.bad[d]--
		}
	}
	s.a[i] = v
}

// IsPeriod reports whether p is a period: a[i] == a[i+p] for all valid i.
// p must satisfy 1 <= p <= n; p == n holds vacuously.
func (s *Seq) IsPeriod(p int) bool {
	n := len(s.a)
	if p < 1 || p > n {
		return false
	}
	return p == n || s.bad[p] == 0
}

// MinPeriod returns the smallest period, in 1..n. It is 0 for an empty
// sequence and 1 for a constant (or single-element) sequence.
func (s *Seq) MinPeriod() int {
	n := len(s.a)
	for p := 1; p <= n; p++ {
		if s.IsPeriod(p) {
			return p
		}
	}
	return 0
}

// Periods lists all periods in increasing order.
func (s *Seq) Periods() []int {
	n := len(s.a)
	out := make([]int, 0, n)
	for p := 1; p <= n; p++ {
		if s.IsPeriod(p) {
			out = append(out, p)
		}
	}
	return out
}

// FirstMismatch returns the first pair (i, i+p) with a[i] != a[i+p],
// i.e. the earliest witness that p is not a period. ok is false when p is
// a period (or out of range).
func (s *Seq) FirstMismatch(p int) (i, j int, ok bool) {
	n := len(s.a)
	if p < 1 || p > n {
		return 0, 0, false
	}
	for i = 0; i+p < n; i++ {
		if s.a[i] != s.a[i+p] {
			return i, i + p, true
		}
	}
	return 0, 0, false
}
