// Package seqperiods maintains a finite integer sequence under point
// updates and answers period queries.
//
// A positive integer p is a period of the sequence a[0..n) when
// a[i] == a[i+p] for every i with i+p < n. The length n is not required
// to be a multiple of p, and p == n is always a (trivial) period.
//
// The implementation stores a double-modulo polynomial rolling hash on
// two Fenwick trees, so Set costs O(log n) and a period check costs
// O(log n). AllPeriods and MinPeriod scan candidates and cost
// O(n log n); FirstMismatch binary-searches the hashes in O(log^2 n).
package seqperiods

const (
	mod1 int64 = 1000000007
	mod2 int64 = 1000000009
	base int64 = 91138233
)

func norm(v, m int64) int64 {
	r := v % m
	if r < 0 {
		r += m
	}
	return r
}

// fenwick is a Fenwick tree over Z_m supporting point adds and prefix sums.
type fenwick struct {
	mod  int64
	tree []int64
}

func newFenwick(n int, mod int64) *fenwick {
	return &fenwick{mod: mod, tree: make([]int64, n+1)}
}

func (f *fenwick) add(i int, v int64) {
	for i++; i < len(f.tree); i += i & -i {
		f.tree[i] = (f.tree[i] + v) % f.mod
	}
}

// sum returns sum of the first i elements, i.e. indices [0, i).
func (f *fenwick) sum(i int) int64 {
	var s int64
	for ; i > 0; i -= i & -i {
		s = (s + f.tree[i]) % f.mod
	}
	return s
}

// Sequence is a dynamic integer sequence with period queries.
type Sequence struct {
	n    int
	a    []int64
	pow1 []int64
	pow2 []int64
	bit1 *fenwick
	bit2 *fenwick
}

// New builds a Sequence from the given values in O(n log n).
func New(values []int64) *Sequence {
	n := len(values)
	s := &Sequence{
		n:    n,
		a:    make([]int64, n),
		pow1: make([]int64, n+1),
		pow2: make([]int64, n+1),
		bit1: newFenwick(n, mod1),
		bit2: newFenwick(n, mod2),
	}
	s.pow1[0], s.pow2[0] = 1, 1
	for i := 1; i <= n; i++ {
		s.pow1[i] = s.pow1[i-1] * base % mod1
		s.pow2[i] = s.pow2[i-1] * base % mod2
	}
	for i, v := range values {
		s.a[i] = v
		s.bit1.add(i, norm(v, mod1)*s.pow1[i]%mod1)
		s.bit2.add(i, norm(v, mod2)*s.pow2[i]%mod2)
	}
	return s
}

// Len returns the length of the sequence.
func (s *Sequence) Len() int { return s.n }

// At returns the current value at index i.
func (s *Sequence) At(i int) int64 {
	if i < 0 || i >= s.n {
		panic("seqperiods: index out of range")
	}
	return s.a[i]
}

// Set assigns a[i] = v in O(log n).
func (s *Sequence) Set(i int, v int64) {
	if i < 0 || i >= s.n {
		panic("seqperiods: index out of range")
	}
	if s.a[i] == v {
		return
	}
	d1 := (norm(v, mod1) - norm(s.a[i], mod1) + mod1) % mod1
	d2 := (norm(v, mod2) - norm(s.a[i], mod2) + mod2) % mod2
	s.bit1.add(i, d1*s.pow1[i]%mod1)
	s.bit2.add(i, d2*s.pow2[i]%mod2)
	s.a[i] = v
}

// equal reports whether the substrings a[l1..l1+length) and
// a[l2..l2+length) are equal, by comparing aligned rolling hashes.
func (s *Sequence) equal(l1, l2, length int) bool {
	if l1 == l2 {
		return true
	}
	h1 := (s.bit1.sum(l1+length) - s.bit1.sum(l1) + mod1) % mod1
	h2 := (s.bit1.sum(l2+length) - s.bit1.sum(l2) + mod1) % mod1
	if h1*s.pow1[l2]%mod1 != h2*s.pow1[l1]%mod1 {
		return false
	}
	g1 := (s.bit2.sum(l1+length) - s.bit2.sum(l1) + mod2) % mod2
	g2 := (s.bit2.sum(l2+length) - s.bit2.sum(l2) + mod2) % mod2
	return g1*s.pow2[l2]%mod2 == g2*s.pow2[l1]%mod2
}

// IsPeriod reports whether p is a period of the sequence: a[i] == a[i+p]
// for all i with i+p < n. Every p >= n is trivially a period.
func (s *Sequence) IsPeriod(p int) bool {
	if p < 1 {
		panic("seqperiods: period must be positive")
	}
	if p >= s.n {
		return true
	}
	return s.equal(0, p, s.n-p)
}

// FirstMismatch returns the first pair of indices (i, i+p) at which the
// period condition for p fails, i.e. the smallest i with a[i] != a[i+p].
// The returned bool is false when p is a period (no such pair exists).
func (s *Sequence) FirstMismatch(p int) (i, j int, ok bool) {
	if p < 1 {
		panic("seqperiods: period must be positive")
	}
	m := s.n - p
	if m <= 0 {
		return 0, 0, false
	}
	// Largest L in [0, m] with a[0..L) == a[p..p+L); prefixes are monotone.
	lo, hi := 0, m
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if s.equal(0, p, mid) {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	if lo == m {
		return 0, 0, false
	}
	return lo, lo + p, true
}

// CheckPeriod reports whether p is a period; if not, it also returns the
// first pair of indices (i, i+p) witnessing the failure.
func (s *Sequence) CheckPeriod(p int) (ok bool, i, j int) {
	i, j, bad := s.FirstMismatch(p)
	return !bad, i, j
}

// MinPeriod returns the smallest period of the sequence in O(n log n).
// It is always defined: for a non-empty sequence the answer is at most n.
func (s *Sequence) MinPeriod() int {
	for p := 1; p <= s.n; p++ {
		if s.IsPeriod(p) {
			return p
		}
	}
	return 0 // empty sequence
}

// AllPeriods returns every period p in [1, n] in increasing order.
func (s *Sequence) AllPeriods() []int {
	var out []int
	for p := 1; p <= s.n; p++ {
		if s.IsPeriod(p) {
			out = append(out, p)
		}
	}
	return out
}
