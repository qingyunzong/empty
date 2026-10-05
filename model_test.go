package permset

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

// Small integer domain used for model-based acceptance testing. Random
// literals are drawn from [-4,4]; membership is checked on the wider
// probe range [-6,6] to cover boundary behavior.
const (
	modelLo   = -6
	modelHi   = 6
	modelIter = 3000
)

// randNode builds a random AST over literals in [-4,4] and names A, B.
func randNode(r *rand.Rand, depth int) node {
	if depth == 0 || r.Intn(3) == 0 {
		if r.Intn(4) == 0 {
			if r.Intn(2) == 0 {
				return nameNode{name: "A"}
			}
			return nameNode{name: "B"}
		}
		lo := int64(r.Intn(9) - 4)
		hi := lo + int64(r.Intn(5))
		if hi > 4 {
			hi = 4
		}
		return litNode{lo: lo, hi: hi, text: fmt.Sprintf("[%d,%d]", lo, hi)}
	}
	op := "|&-"[r.Intn(3)]
	return binNode{op: op, l: randNode(r, depth-1), r: randNode(r, depth-1)}
}

// nodeString renders an AST as a fully parenthesized expression.
func nodeString(n node) string {
	switch n := n.(type) {
	case litNode:
		return n.text
	case nameNode:
		return n.name
	case binNode:
		return "(" + nodeString(n.l) + string(n.op) + nodeString(n.r) + ")"
	}
	panic("unreachable")
}

// modelContains is the naive pointwise set model: A=[-2,2], B=[0,4].
func modelContains(n node, x int64) bool {
	switch n := n.(type) {
	case litNode:
		return n.lo <= x && x <= n.hi
	case nameNode:
		if n.name == "A" {
			return -2 <= x && x <= 2
		}
		return 0 <= x && x <= 4
	case binNode:
		switch n.op {
		case '|':
			return modelContains(n.l, x) || modelContains(n.r, x)
		case '&':
			return modelContains(n.l, x) && modelContains(n.r, x)
		case '-':
			return modelContains(n.l, x) && !modelContains(n.r, x)
		}
	}
	panic("unreachable")
}

// TestSmallDomainModel cross-checks the interval engine against a naive
// per-point set model on a small integer domain, for randomly generated
// expressions. Each expression is evaluated both directly and through
// parse+Env.Eval of its rendered text, and both must agree with the
// model at every probe point.
func TestSmallDomainModel(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[-2,2]")
	mustDefine(t, e, "B", "[0,4]")
	r := rand.New(rand.NewSource(1))
	for i := 0; i < modelIter; i++ {
		n := randNode(r, 3)
		w, err := evalNode(n, e.resolve)
		if err != nil {
			t.Fatalf("iter %d: %v", i, err)
		}
		got := w.Set()
		checkCanonical(t, got)
		// Round-trip through the parser and the environment.
		w2, err := e.Eval(nodeString(n))
		if err != nil {
			t.Fatalf("iter %d: Eval(%s): %v", i, nodeString(n), err)
		}
		if !w2.Set().Equal(got) || !equalWSets(w2, w) {
			t.Fatalf("iter %d: %s: direct %v != parsed %v", i, nodeString(n), w, w2)
		}
		for x := int64(modelLo); x <= modelHi; x++ {
			want := modelContains(n, x)
			if got.Contains(x) != want {
				t.Fatalf("iter %d: %s: membership at %d = %v, model says %v (set %v)",
					i, nodeString(n), x, !want, want, got)
			}
		}
	}
	if err := e.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// TestExtremeValueAcceptance probes membership at the int64 boundaries
// for expressions exercising union, intersection and difference at the
// extremes.
func TestExtremeValueAcceptance(t *testing.T) {
	cases := []struct {
		src     string
		present []int64
		absent  []int64
	}{
		{
			"[min,max] - [max,max]",
			[]int64{math.MinInt64, 0, math.MaxInt64 - 1},
			[]int64{math.MaxInt64},
		},
		{
			"[min,max] - [min,min]",
			[]int64{math.MinInt64 + 1, 0, math.MaxInt64},
			[]int64{math.MinInt64},
		},
		{
			"[min,-1] | [0,max]",
			[]int64{math.MinInt64, -1, 0, math.MaxInt64},
			nil,
		},
		{
			"[min,-9223372036854775803] & [-9223372036854775803,max]",
			[]int64{math.MinInt64 + 5},
			[]int64{math.MinInt64 + 4, math.MinInt64 + 6},
		},
		{
			"[9223372036854775802,max] - [9223372036854775805,max]",
			[]int64{math.MaxInt64 - 5, math.MaxInt64 - 3},
			[]int64{math.MaxInt64 - 2, math.MaxInt64},
		},
		{
			"[min,max] - [-9223372036854775807,9223372036854775806]",
			[]int64{math.MinInt64, math.MaxInt64},
			[]int64{math.MinInt64 + 1, 0, math.MaxInt64 - 1},
		},
	}
	for _, c := range cases {
		s, err := Eval(c.src)
		if err != nil {
			t.Fatalf("Eval(%q): %v", c.src, err)
		}
		checkCanonical(t, s)
		for _, x := range c.present {
			if !s.Contains(x) {
				t.Fatalf("Eval(%q) = %v: should contain %d", c.src, s, x)
			}
		}
		for _, x := range c.absent {
			if s.Contains(x) {
				t.Fatalf("Eval(%q) = %v: should not contain %d", c.src, s, x)
			}
		}
	}
}
