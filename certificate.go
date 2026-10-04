package statmatch

import (
	"fmt"
	"math/big"
	"strings"
)

// Certificate is a self-contained record of an alignment and its exact
// statistics: both series (at most MaxPoints points each), the maximum
// gap, the matched pairs, the power sums, and the derived statistics.
// Verify replays the matching and the direct summation independently.
type Certificate struct {
	MaxGap *big.Rat
	A, B   []Point
	Pairs  []Pair
	Sums   *Sums
	Stats  Stats
}

// Certificate builds a certificate for the aligner's current state and
// verifies it before returning.
func (al *Aligner) Certificate() (*Certificate, error) {
	a, b := al.Points()
	c := &Certificate{
		MaxGap: new(big.Rat).Set(al.maxGap),
		A:      a,
		B:      b,
		Pairs:  al.Pairs(),
		Sums:   al.Sums(),
		Stats:  al.Stats(),
	}
	if err := c.Verify(); err != nil {
		return nil, err
	}
	return c, nil
}

// Verify independently replays the matching from the recorded series
// and maximum gap, recomputes the sums by direct summation, and checks
// every recorded statistic.
func (c *Certificate) Verify() error {
	if len(c.A) > MaxPoints || len(c.B) > MaxPoints {
		return fmt.Errorf("statmatch: certificate exceeds %d points per series", MaxPoints)
	}
	pairs := Match(c.A, c.B, c.MaxGap)
	if !samePairs(pairs, c.Pairs) {
		return fmt.Errorf("statmatch: certificate pairs do not match replayed matching")
	}
	sums := DirectSums(pairs)
	if !sums.Equal(c.Sums) {
		return fmt.Errorf("statmatch: certificate sums do not match direct summation")
	}
	st := sums.Stats()
	if st.N != c.Stats.N || st.Defined != c.Stats.Defined ||
		st.Cov.Cmp(c.Stats.Cov) != 0 ||
		st.VarX.Cmp(c.Stats.VarX) != 0 ||
		st.VarY.Cmp(c.Stats.VarY) != 0 {
		return fmt.Errorf("statmatch: certificate statistics mismatch")
	}
	if st.Defined && !radicalEqual(st.R, c.Stats.R) {
		return fmt.Errorf("statmatch: certificate correlation mismatch")
	}
	return nil
}

func samePairs(p, q []Pair) bool {
	if len(p) != len(q) {
		return false
	}
	for i := range p {
		if p[i].A.ID != q[i].A.ID || p[i].B.ID != q[i].B.ID {
			return false
		}
	}
	return true
}

// String renders the certificate as a human-readable report.
func (c *Certificate) String() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "max gap: %s\n", c.MaxGap.RatString())
	fmt.Fprintf(&sb, "series A (%d points):\n", len(c.A))
	for _, p := range c.A {
		fmt.Fprintf(&sb, "  %s t=%s v=%d\n", p.ID, p.T.RatString(), p.V)
	}
	fmt.Fprintf(&sb, "series B (%d points):\n", len(c.B))
	for _, p := range c.B {
		fmt.Fprintf(&sb, "  %s t=%s v=%d\n", p.ID, p.T.RatString(), p.V)
	}
	fmt.Fprintf(&sb, "matching (%d pairs):\n", len(c.Pairs))
	for _, p := range c.Pairs {
		fmt.Fprintf(&sb, "  %s~%s |dt|=%s x=%d y=%d\n",
			p.A.ID, p.B.ID, p.Diff.RatString(), p.A.V, p.B.V)
	}
	fmt.Fprintf(&sb, "n=%d Sx=%s Sy=%s Sxx=%s Sxy=%s Syy=%s\n",
		c.Sums.N, c.Sums.Sx, c.Sums.Sy, c.Sums.Sxx, c.Sums.Sxy, c.Sums.Syy)
	fmt.Fprintf(&sb, "cov=%s varX=%s varY=%s\n",
		c.Stats.Cov, c.Stats.VarX, c.Stats.VarY)
	if c.Stats.Defined {
		fmt.Fprintf(&sb, "r=%s\n", c.Stats.R)
	} else {
		sb.WriteString("r=undefined\n")
	}
	return sb.String()
}
