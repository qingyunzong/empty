package dataeng

import (
	"math/rand"
	"reflect"
	"testing"
)

// buildTree returns a tree with IDs assigned in document preorder:
//
//	0 root
//	├─ 1 a
//	│  ├─ 2 b
//	│  │  └─ 3 a
//	│  │     └─ 4 b
//	│  ├─ 5 b
//	│  └─ 6 c
//	├─ 7 a
//	│  └─ 8 b
//	│     └─ 9 a
//	└─ 10 c
//	   └─ 11 a
func buildTree() *Node {
	return &Node{ID: 0, Tag: "root", Children: []*Node{
		{ID: 1, Tag: "a", Children: []*Node{
			{ID: 2, Tag: "b", Children: []*Node{
				{ID: 3, Tag: "a", Children: []*Node{
					{ID: 4, Tag: "b"},
				}},
			}},
			{ID: 5, Tag: "b"},
			{ID: 6, Tag: "c"},
		}},
		{ID: 7, Tag: "a", Children: []*Node{
			{ID: 8, Tag: "b", Children: []*Node{
				{ID: 9, Tag: "a"},
			}},
		}},
		{ID: 10, Tag: "c", Children: []*Node{
			{ID: 11, Tag: "a"},
		}},
	}}
}

func TestEvalSemantics(t *testing.T) {
	root := buildTree()

	tests := []struct {
		expr string
		want []int
	}{
		{"a", []int{1, 7}},
		{"*", []int{1, 7, 10}},
		{"*[2]", []int{7}},
		{"*[last()]", []int{10}},
		{"a/b", []int{2, 5, 8}},
		// Position is computed per parent, not over the merged union.
		{"a/b[1]", []int{2, 8}},
		{"a/b[2]", []int{5}},
		{"a/b[3]", nil},
		{"a/b[last()]", []int{5, 8}},
		{"a/c", []int{6}},
		{"a/b/a", []int{3, 9}},
		// Nested same-name nodes reached via the descendant axis.
		{"*//a", []int{3, 9, 11}},
		{"*//b", []int{2, 4, 5, 8}},
		{"a//a", []int{3, 9}},
		{"a//b", []int{2, 4, 5, 8}},
		{"a//b[1]", []int{2, 8}},
		{"a//b[2]", []int{4}},
		{"a//b[last()]", []int{5, 8}},
		{"a//a//b", []int{4}},
		{"a//a/b", []int{4}},
		{"c/a", []int{11}},
		{"a//*", []int{2, 3, 4, 5, 6, 8, 9}},
		{"a[5]", nil},
		{"missing", nil},
		// Unions, including overlapping ones, deduplicate and stay ordered.
		{"a|c", []int{1, 7, 10}},
		{"c|a", []int{1, 7, 10}},
		{"a|*//a", []int{1, 3, 7, 9, 11}},
		{"a/b|*//b", []int{2, 4, 5, 8}},
		{"a/b|a/c", []int{2, 5, 6, 8}},
		{"a/b[1]|a/b[last()]", []int{2, 5, 8}},
		{"missing|c/a", []int{11}},
		{"missing|also-missing", nil},
	}

	for _, tc := range tests {
		t.Run(tc.expr, func(t *testing.T) {
			sel, err := Compile(tc.expr)
			if err != nil {
				t.Fatalf("Compile(%q) unexpected error: %v", tc.expr, err)
			}
			if got := sel.EvalIDs(root); !sameIDs(got, tc.want) {
				t.Fatalf("EvalIDs(%q) = %v, want %v", tc.expr, got, tc.want)
			}
			naive, err := naiveEval(tc.expr, root)
			if err != nil {
				t.Fatalf("naiveEval(%q) unexpected error: %v", tc.expr, err)
			}
			if !sameIDs(naive, tc.want) {
				t.Fatalf("naiveEval(%q) = %v, want %v", tc.expr, naive, tc.want)
			}
		})
	}
}

func TestPerParentPositionNotMerged(t *testing.T) {
	// Two parents each with matching children; [1] must keep the first child
	// of every parent rather than collapse to the global first match.
	root := buildTree()
	sel := MustCompile("a/b[1]")
	got := sel.EvalIDs(root)
	want := []int{2, 8}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	nodes := MustCompile("a/b[1]").Eval(root)
	if len(nodes) != 2 || nodes[0].ID != 2 || nodes[1].ID != 8 {
		t.Fatalf("Eval returned %+v", nodes)
	}
}

func TestDescendantOverlapDedup(t *testing.T) {
	root := buildTree()
	// The same nodes are reachable through several ancestor inputs; the
	// engine must deduplicate while preserving document order.
	got := MustCompile("*//b|a//b|*//a//b").EvalIDs(root)
	want := []int{2, 4, 5, 8}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func sameIDs(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestSyntaxErrorsCarryByteOffset(t *testing.T) {
	tests := []struct {
		expr   string
		offset int
	}{
		{"", 0},
		{"/a", 0},
		{"//a", 0},
		{"/", 0},
		{"a/", 2},
		{"a//", 3},
		{"a/b//", 5},
		{"a//b/", 5},
		{"a//b//", 6},
		{"a/[1]", 2},
		{"|a", 0},
		{"a|", 2},
		{"a||b", 2},
		{"a|/b", 2},
		{"a[]", 2},
		{"a[0]", 2},
		{"a[01]", 2},
		{"a[last]", 2},
		{"a[ Last() ]", 2},
		{"a[1 ]", 2},
		{"a[1][2]", 4},
		{"a[1", 1},
		{"a[1]b", 4},
		{"a b", 1},
		{"a[999999999999999999999999]", 2},
		{"a/last()", 6},
	}

	for _, tc := range tests {
		t.Run(tc.expr, func(t *testing.T) {
			_, err := Compile(tc.expr)
			if err == nil {
				t.Fatalf("Compile(%q) expected error, got nil", tc.expr)
			}
			pe, ok := err.(*ParseError)
			if !ok {
				t.Fatalf("Compile(%q) error type %T, want *ParseError", tc.expr, err)
			}
			if pe.Offset != tc.offset {
				t.Fatalf("Compile(%q) offset = %d, want %d (%v)", tc.expr, pe.Offset, tc.offset, err)
			}
			if pe.Offset < 0 || pe.Offset > len(tc.expr) {
				t.Fatalf("offset %d out of range for %q", pe.Offset, tc.expr)
			}
		})
	}
}

func TestFailedCompileDoesNotTouchTree(t *testing.T) {
	root := buildTree()
	before := MustCompile("*//*").EvalIDs(root)

	if _, err := Compile("a//"); err == nil {
		t.Fatal("expected syntax error")
	}
	after := MustCompile("*//*").EvalIDs(root)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("tree changed after failed compile: %v vs %v", before, after)
	}
}

func TestRepeatedEvaluationAndNilSafety(t *testing.T) {
	root := buildTree()
	sel := MustCompile("a/b[1]|*//a")

	first := sel.EvalIDs(root)
	for i := 0; i < 5; i++ {
		if got := sel.EvalIDs(root); !reflect.DeepEqual(got, first) {
			t.Fatalf("iteration %d: got %v, want %v", i, got, first)
		}
	}

	var nilSel *Selector
	if got := nilSel.Eval(root); got != nil {
		t.Fatalf("nil selector Eval = %v, want nil", got)
	}
	if got := sel.Eval(nil); got != nil {
		t.Fatalf("nil root Eval = %v, want nil", got)
	}

	if MustCompile("a").Paths() != 1 || MustCompile("a|b|c").Paths() != 3 {
		t.Fatal("Paths() mismatch")
	}
}

func TestRandomExpressionsMatchNaiveInterpreter(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	tags := []string{"a", "b", "c"}
	predicates := []string{"", "[1]", "[2]", "[last()]"}

	for iteration := 0; iteration < 500; iteration++ {
		pathCount := 1 + rng.Intn(3)
		var expr string
		for p := 0; p < pathCount; p++ {
			if p > 0 {
				expr += "|"
			}
			stepCount := 1 + rng.Intn(4)
			for s := 0; s < stepCount; s++ {
				if s > 0 {
					if rng.Intn(2) == 0 {
						expr += "//"
					} else {
						expr += "/"
					}
				}
				if rng.Intn(4) == 0 {
					expr += "*"
				} else {
					expr += tags[rng.Intn(len(tags))]
				}
				expr += predicates[rng.Intn(len(predicates))]
			}
		}

		tree := buildTree()
		sel, err := Compile(expr)
		if err != nil {
			t.Fatalf("iteration %d: generator produced invalid expr %q: %v", iteration, expr, err)
		}
		got := sel.EvalIDs(tree)
		naive, err := naiveEval(expr, tree)
		if err != nil {
			t.Fatalf("iteration %d: naive error for %q: %v", iteration, expr, err)
		}
		if !sameIDs(got, naive) {
			t.Fatalf("iteration %d: expr %q engine=%v naive=%v", iteration, expr, got, naive)
		}
	}
}

func TestRandomArbitraryStringsNeverPanic(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	alphabet := []byte("abc*/|[]() last0123456789\t")

	for iteration := 0; iteration < 1000; iteration++ {
		n := rng.Intn(24)
		buf := make([]byte, n)
		for i := range buf {
			buf[i] = alphabet[rng.Intn(len(alphabet))]
		}

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("iteration %d: Compile(%q) panicked: %v", iteration, string(buf), r)
				}
			}()
			sel, err := Compile(string(buf))
			if err == nil {
				_ = sel.EvalIDs(buildTree())
				return
			}
			pe, ok := err.(*ParseError)
			if !ok || pe.Offset < 0 || pe.Offset > len(buf) {
				t.Fatalf("iteration %d: bad error %v for %q", iteration, err, string(buf))
			}
		}()
	}
}
