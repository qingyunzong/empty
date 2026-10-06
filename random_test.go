package foldexpr

import (
	"math/rand"
	"testing"
)

var randVars = []string{"a", "b", "c", "d"}

var randConstPool = []int32{
	0, 0, 1, 2, 3, 5, 7, 10, 100,
	-1, -2, -3, -7,
	2147483647, -2147483648, 2147483646,
}

func randConstVal(r *rand.Rand) int32 {
	if r.Intn(4) == 0 {
		return int32(r.Uint32())
	}
	return randConstPool[r.Intn(len(randConstPool))]
}

func randExpr(r *rand.Rand, depth int) Node {
	if depth >= 5 || r.Intn(10) < 3 {
		if r.Intn(2) == 0 {
			return &Const{Val: randConstVal(r)}
		}
		return &Var{Name: randVars[r.Intn(len(randVars))]}
	}
	switch r.Intn(9) {
	case 0:
		return &Cond{
			C: randExpr(r, depth+1),
			T: randExpr(r, depth+1),
			F: randExpr(r, depth+1),
		}
	case 1:
		op := "-"
		if r.Intn(2) == 0 {
			op = "!"
		}
		return &Unary{Op: op, X: randExpr(r, depth+1)}
	default:
		ops := []string{
			"+", "-", "*",
			"/", "/", "%", // extra weight to provoke traps
			"&&", "||",
			"==", "!=", "<", "<=", ">", ">=",
		}
		return &Binary{
			Op: ops[r.Intn(len(ops))],
			L:  randExpr(r, depth+1),
			R:  randExpr(r, depth+1),
		}
	}
}

// TestRandomFoldConsistency evaluates randomly generated expressions
// with random environments before and after folding, and requires:
//   - identical values when both evaluations succeed, and
//   - identical trap positions when both evaluations trap.
func TestRandomFoldConsistency(t *testing.T) {
	r := rand.New(rand.NewSource(20261007))
	const iterations = 50000
	var traps, values int
	for i := 0; i < iterations; i++ {
		orig := randExpr(r, 0)
		env := make(map[string]int32, len(randVars))
		for _, v := range randVars {
			env[v] = randConstVal(r)
		}
		folded := Fold(orig)

		v1, err1 := Eval(orig, env)
		v2, err2 := Eval(folded, env)

		te1, trap1 := err1.(*TrapError)
		te2, trap2 := err2.(*TrapError)
		if trap1 != trap2 {
			t.Fatalf("iter %d: trap mismatch before=%v after=%v\nbefore: %s\nafter: %s",
				i, err1, err2, Dump(orig), Dump(folded))
		}
		if trap1 {
			traps++
			if te1.Pos != te2.Pos {
				t.Fatalf("iter %d: trap pos before=%d after=%d\nbefore: %s\nafter: %s",
					i, te1.Pos, te2.Pos, Dump(orig), Dump(folded))
			}
			continue
		}
		if err1 != nil || err2 != nil {
			t.Fatalf("iter %d: unexpected errors before=%v after=%v", i, err1, err2)
		}
		values++
		if v1 != v2 {
			t.Fatalf("iter %d: value mismatch before=%d after=%d\nbefore: %s\nafter: %s",
				i, v1, v2, Dump(orig), Dump(folded))
		}
	}
	t.Logf("checked %d expressions: %d trapped (positions matched), %d produced values", iterations, traps, values)
}

// TestRandomParsedRoundTrip generates random ASTs, prints them to
// source, re-parses, folds, and compares evaluation results. This
// exercises the parser against the same consistency invariant.
func TestRandomParsedRoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for i := 0; i < 5000; i++ {
		orig := randExpr(r, 0)
		src := orig.String()
		// Trap nodes cannot appear in freshly generated ASTs, so the
		// printed form is always parseable.
		parsed, err := Parse(src)
		if err != nil {
			t.Fatalf("iter %d: reparse %q: %v", i, src, err)
		}
		env := make(map[string]int32, len(randVars))
		for _, v := range randVars {
			env[v] = randConstVal(r)
		}
		v1, err1 := Eval(Fold(parsed), env)
		v2, err2 := Eval(parsed, env)
		te1, trap1 := err1.(*TrapError)
		te2, trap2 := err2.(*TrapError)
		if trap1 != trap2 || (trap1 && te1.Pos != te2.Pos) {
			t.Fatalf("iter %d: trap mismatch %v vs %v for %q", i, err1, err2, src)
		}
		if !trap1 && v1 != v2 {
			t.Fatalf("iter %d: %d != %d for %q", i, v1, v2, src)
		}
	}
}
