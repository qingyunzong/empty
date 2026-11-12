package dataeng

import (
	"fmt"
	mbits "math/bits"
)

// combTable[n][k] holds C(n,k) exactly.  For n <= 63 the largest entry,
// C(63,31), fits comfortably in uint64.
var combTable [MaxBlockWidth + 1][MaxBlockWidth + 1]uint64

func init() {
	for n := 0; n <= MaxBlockWidth; n++ {
		combTable[n][0] = 1
		combTable[n][n] = 1
		for k := 1; k < n; k++ {
			combTable[n][k] = combTable[n-1][k-1] + combTable[n-1][k]
		}
	}
}

func binomial(n, k int) uint64 {
	if n < 0 || n > MaxBlockWidth || k < 0 || k > n {
		return 0
	}
	return combTable[n][k]
}

// minWidth returns the least w such that 2^w >= c.  It deliberately avoids
// floating point logarithms: bits.Len64(c-1) is exactly ceil(log2(c)) for
// c > 1.
func minWidth(c uint64) uint {
	if c <= 1 {
		return 0
	}
	return uint(mbits.Len64(c - 1))
}

func classWidth(b int) uint {
	return uint(mbits.Len(uint(b)))
}

// rankOrdinal computes the zero-based index of pattern among all m-bit words
// with exactly c one bits, ordered by their ordinary integer value.  The first
// logical bit is the most significant bit of the m-bit word.
func rankOrdinal(m, c int, pattern uint64) (uint64, error) {
	if m < 0 || m > MaxBlockWidth || c < 0 || c > m {
		return 0, fmt.Errorf("%w: ordinal m=%d c=%d", ErrMalformedPayload, m, c)
	}
	if pattern >= uint64(1)<<uint(m) {
		return 0, fmt.Errorf("%w: pattern %#x has bits above m=%d", ErrMalformedPayload, pattern, m)
	}

	var rank uint64
	remainingLen := m
	remainingOnes := c
	for j := 0; j < m; j++ {
		remainingLen--
		bit := (pattern >> uint(m-1-j)) & 1
		if bit != 0 {
			// Putting zero here and the same number of remaining ones in
			// the suffix yields a numerically smaller word.
			rank += binomial(remainingLen, remainingOnes)
			remainingOnes--
		}
	}
	if remainingOnes != 0 {
		return 0, fmt.Errorf("%w: pattern has fewer than c=%d ones", ErrMalformedPayload, c)
	}
	return rank, nil
}

// unrankOrdinal is the inverse of rankOrdinal.
func unrankOrdinal(m, c int, ordinal uint64) (uint64, error) {
	if m < 0 || m > MaxBlockWidth || c < 0 || c > m {
		return 0, fmt.Errorf("%w: ordinal m=%d c=%d", ErrMalformedPayload, m, c)
	}
	combinations := binomial(m, c)
	if combinations == 0 || ordinal >= combinations {
		return 0, fmt.Errorf("%w: ordinal %d >= C(%d,%d)=%d",
			ErrMalformedPayload, ordinal, m, c, combinations)
	}

	var pattern uint64
	remainingLen := m
	remainingOnes := c
	for j := 0; j < m; j++ {
		remainingLen--
		zeroBranch := binomial(remainingLen, remainingOnes)
		if ordinal >= zeroBranch {
			pattern |= uint64(1) << uint(m-1-j)
			ordinal -= zeroBranch
			remainingOnes--
		}
	}
	if remainingOnes != 0 {
		return 0, fmt.Errorf("%w: ordinal %d did not yield c=%d ones", ErrMalformedPayload, ordinal, c)
	}
	return pattern, nil
}

func patternOnesUpTo(pattern uint64, m, end int) uint64 {
	if end <= 0 {
		return 0
	}
	if end >= m {
		return uint64(mbits.OnesCount64(pattern))
	}
	return uint64(mbits.OnesCount64(pattern >> uint(m-end)))
}

func selectInPattern(pattern uint64, m, k int, wantOne bool) (int, bool) {
	seen := 0
	for j := 0; j < m; j++ {
		bit := (pattern >> uint(m-1-j)) & 1
		matches := bit == 1
		if !wantOne {
			matches = !matches
		}
		if matches {
			if seen == k {
				return j, true
			}
			seen++
		}
	}
	return 0, false
}
