package intfold

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// genExpr appends a random expression string to sb. Division and modulo by
// possibly-zero constants, short-circuit operators, conditionals and
// wraparound-sized literals are all generated on purpose.
func genExpr(r *rand.Rand, depth int, sb *strings.Builder) {
	lit := func() {
		switch r.Intn(6) {
		case 0:
			sb.WriteString("0")
		case 1:
			fmt.Fprintf(sb, "%d", r.Intn(10))
		case 2:
			fmt.Fprintf(sb, "%d", r.Int31()) // may overflow int32 -> wraps
		default:
			fmt.Fprintf(sb, "%d", r.Intn(100)-50)
		}
	}
	var_ := func() {
		sb.WriteByte(byte('a' + r.Intn(3))) // a, b, c
	}
	if depth <= 0 {
		if r.Intn(2) == 0 {
			lit()
		} else {
			var_()
		}
		return
	}
	switch r.Intn(10) {
	case 0, 1: // arithmetic, division/mod included
		op := []string{"+", "-", "*", "/", "%"}[r.Intn(5)]
		sb.WriteByte('(')
		genExpr(r, depth-1, sb)
		fmt.Fprintf(sb, " %s ", op)
		genExpr(r, depth-1, sb)
		sb.WriteByte(')')
	case 2: // comparison
		op := []string{"==", "!=", "<", "<=", ">", ">="}[r.Intn(6)]
		sb.WriteByte('(')
		genExpr(r, depth-1, sb)
		fmt.Fprintf(sb, " %s ", op)
		genExpr(r, depth-1, sb)
		sb.WriteByte(')')
	case 3: // logical and
		sb.WriteByte('(')
		genExpr(r, depth-1, sb)
		sb.WriteString(" && ")
		genExpr(r, depth-1, sb)
		sb.WriteByte(')')
	case 4: // logical or
		sb.WriteByte('(')
		genExpr(r, depth-1, sb)
		sb.WriteString(" || ")
		genExpr(r, depth-1, sb)
		sb.WriteByte(')')
	case 5: // conditional
		sb.WriteByte('(')
		genExpr(r, depth-1, sb)
		sb.WriteString(" ? ")
		genExpr(r, depth-1, sb)
		sb.WriteString(" : ")
		genExpr(r, depth-1, sb)
		sb.WriteByte(')')
	case 6: // unary
		if r.Intn(2) == 0 {
			sb.WriteString("(-")
		} else {
			sb.WriteString("(!")
		}
		genExpr(r, depth-1, sb)
		sb.WriteByte(')')
	case 7: // explicit constant division/modulo by zero
		if r.Intn(2) == 0 {
			sb.WriteString("(1 / 0)")
		} else {
			sb.WriteString("(1 % 0)")
		}
	default:
		if r.Intn(2) == 0 {
			lit()
		} else {
			var_()
		}
	}
}

func randEnv(r *rand.Rand) map[string]int32 {
	edge := []int32{0, 1, -1, 2, 2147483647, -2147483648}
	env := map[string]int32{}
	for _, name := range []string{"a", "b", "c"} {
		if r.Intn(2) == 0 {
			env[name] = edge[r.Intn(len(edge))]
		} else {
			env[name] = r.Int31()
			if r.Intn(2) == 0 {
				env[name] = -env[name]
			}
		}
	}
	return env
}

// TestFoldDifferential evaluates the original and the folded AST on random
// inputs and requires identical values and identical trap positions.
func TestFoldDifferential(t *testing.T) {
	const exprs = 400
	const envsPerExpr = 25
	r := rand.New(rand.NewSource(20261007))
	for i := 0; i < exprs; i++ {
		var sb strings.Builder
		genExpr(r, 4+r.Intn(3), &sb)
		src := sb.String()
		e, err := Parse(src)
		if err != nil {
			t.Fatalf("Parse(%q): %v", src, err)
		}
		f := Fold(e)
		for j := 0; j < envsPerExpr; j++ {
			env := randEnv(r)
			v1, t1 := Eval(e, env)
			v2, t2 := Eval(f, env)
			if (t1 == nil) != (t2 == nil) {
				t.Fatalf("src=%q env=%v\noriginal: (%d, %v)\nfolded:   (%d, %v)",
					src, env, v1, t1, v2, t2)
			}
			if t1 != nil {
				if t1.Span != t2.Span || t1.Msg != t2.Msg {
					t.Fatalf("src=%q env=%v\ntrap mismatch: %v vs %v", src, env, t1, t2)
				}
			} else if v1 != v2 {
				t.Fatalf("src=%q env=%v\nvalue mismatch: %d vs %d", src, env, v1, v2)
			}
		}
	}
}

// TestFoldIdempotent: folding twice must not change the result.
func TestFoldIdempotent(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for i := 0; i < 200; i++ {
		var sb strings.Builder
		genExpr(r, 4, &sb)
		e, err := Parse(sb.String())
		if err != nil {
			t.Fatal(err)
		}
		once := Dump(Fold(e))
		twice := Dump(Fold(Fold(e)))
		if once != twice {
			t.Fatalf("not idempotent for %q:\n%s\nvs\n%s", sb.String(), once, twice)
		}
	}
}
