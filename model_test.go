package permset

import (
	"fmt"
	"math/rand"
	"slices"
	"testing"
)

// Small integer domain for exhaustive-style model checking.
const (
	domLo = -16
	domHi = 15
	domN  = domHi - domLo + 1
)

// boolsToIntervals converts a dense boolean model over [domLo, domHi]
// into canonical intervals.
func boolsToIntervals(b []bool) []Interval {
	var out []Interval
	for i := 0; i < len(b); {
		if !b[i] {
			i++
			continue
		}
		j := i
		for j+1 < len(b) && b[j+1] {
			j++
		}
		out = append(out, Interval{int64(domLo + i), int64(domLo + j)})
		i = j + 1
	}
	return out
}

func intervalsToBools(ivs []Interval) []bool {
	b := make([]bool, domN)
	for _, iv := range ivs {
		for v := iv.Lo; v <= iv.Hi && v <= domHi; v++ {
			if v >= domLo {
				b[v-domLo] = true
			}
		}
	}
	return b
}

// tnode is a test-side AST mirrored both as an expression string (for the
// library) and as a direct boolean-model evaluator (the oracle).
type tnode struct {
	op   byte // 0 literal, 'r' ref, '|', '&', '-'
	lo   int64
	hi   int64
	name string
	l, r *tnode
}

func (n *tnode) String() string {
	switch n.op {
	case 0:
		return fmt.Sprintf("[%d,%d]", n.lo, n.hi)
	case 'r':
		return n.name
	default:
		return fmt.Sprintf("(%s %c %s)", n.l.String(), n.op, n.r.String())
	}
}

func (n *tnode) eval(model map[string]*tnode, memo map[string][]bool) []bool {
	switch n.op {
	case 0:
		return intervalsToBools([]Interval{{n.lo, n.hi}})
	case 'r':
		return resolveModel(model, memo, n.name)
	default:
		l := n.l.eval(model, memo)
		r := n.r.eval(model, memo)
		out := make([]bool, domN)
		for i := range out {
			switch n.op {
			case '|':
				out[i] = l[i] || r[i]
			case '&':
				out[i] = l[i] && r[i]
			case '-':
				out[i] = l[i] && !r[i]
			}
		}
		return out
	}
}

func resolveModel(model map[string]*tnode, memo map[string][]bool, name string) []bool {
	if b, ok := memo[name]; ok {
		return b
	}
	b := model[name].eval(model, memo)
	memo[name] = b
	return b
}

func genExpr(rnd *rand.Rand, depth int, names []string) *tnode {
	leafOK := depth <= 0
	roll := rnd.Intn(10)
	if leafOK || roll < 4 {
		if len(names) > 0 && rnd.Intn(2) == 0 {
			return &tnode{op: 'r', name: names[rnd.Intn(len(names))]}
		}
		lo := int64(domLo + rnd.Intn(domN))
		hi := lo + int64(rnd.Intn(domLo+domN-int(lo)))
		return &tnode{op: 0, lo: lo, hi: hi}
	}
	op := "|&-"[rnd.Intn(3)]
	return &tnode{op: op, l: genExpr(rnd, depth-1, names), r: genExpr(rnd, depth-1, names)}
}

// Random anonymous expressions: library vs boolean-set oracle.
func TestModelRandomExpressions(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	r := NewRegistry()
	for iter := 0; iter < 500; iter++ {
		n := genExpr(rnd, 3, nil)
		got, err := r.EvalExpr(n.String())
		if err != nil {
			t.Fatalf("iter %d expr %s: %v", iter, n.String(), err)
		}
		want := boolsToIntervals(n.eval(nil, nil))
		if !slices.Equal(got, want) {
			t.Fatalf("iter %d expr %s: got %v want %v", iter, n.String(), got, want)
		}
	}
}

// Random versioned definitions with corrections: current values, frozen
// snapshots, and full-recomputation checks all cross-checked against the
// boolean-set oracle.
func TestModelRandomDefinitionsAndCorrections(t *testing.T) {
	rnd := rand.New(rand.NewSource(2))
	r := NewRegistry()
	names := []string{"S0", "S1", "S2", "S3", "S4", "S5"}
	model := map[string]*tnode{}
	snapshots := map[string][]Interval{} // "name/num" -> frozen value

	checkAll := func(tag string) {
		t.Helper()
		for _, name := range names {
			if model[name] == nil {
				continue
			}
			got := mustEval(t, r, name)
			want := boolsToIntervals(resolveModel(model, map[string][]bool{}, name))
			if !slices.Equal(got, want) {
				t.Fatalf("%s: %s got %v want %v", tag, name, got, want)
			}
		}
		if bad := r.Verify(); len(bad) != 0 {
			t.Fatalf("%s: Verify mismatches %v", tag, bad)
		}
	}

	// Initial definitions: S_i may only reference S_j with j < i, so the
	// graph is acyclic by construction.
	for i, name := range names {
		n := genExpr(rnd, 3, names[:i])
		v := mustDefine(t, r, name, n.String())
		model[name] = n
		snapshots[fmt.Sprintf("%s/%d", name, v.Num)] = boolsToIntervals(n.eval(model, map[string][]bool{}))
	}
	checkAll("initial")

	// Corrections: redefine a random set, still referencing only
	// lower-indexed names (acyclic), then re-check everything.
	for round := 0; round < 60; round++ {
		i := rnd.Intn(len(names))
		n := genExpr(rnd, 3, names[:i])
		v := mustDefine(t, r, names[i], n.String())
		model[names[i]] = n
		snapshots[fmt.Sprintf("%s/%d", names[i], v.Num)] = boolsToIntervals(n.eval(model, map[string][]bool{}))
		checkAll(fmt.Sprintf("round %d", round))
	}

	// Every historical snapshot must still be intact.
	for _, name := range names {
		for _, ver := range r.Versions(name) {
			key := fmt.Sprintf("%s/%d", name, ver.Num)
			got, err := r.Snapshot(name, ver.Num)
			if err != nil {
				t.Fatalf("snapshot %s: %v", key, err)
			}
			if want := snapshots[key]; !slices.Equal(got, want) {
				t.Fatalf("snapshot %s: got %v want %v", key, got, want)
			}
		}
	}
}
