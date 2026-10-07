package matchcheck

import (
	"reflect"
	"testing"
)

var color = Enum("Color", "Red", "Green", "Blue")

func valueStrings(vs []Value) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.String()
	}
	return out
}

func TestEnumExhaustive(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Lit("Green")},
		{Pattern: Lit("Blue")},
	}, Options{})
	if !rep.Exhaustive || !rep.Enumerated {
		t.Fatalf("want exhaustive+enumerated, got %+v", rep)
	}
	if len(rep.Unreachable) != 0 || len(rep.Uncovered) != 0 {
		t.Fatalf("want no findings, got %+v", rep)
	}
}

func TestEnumMissingValue(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Lit("Blue")},
	}, Options{})
	if rep.Exhaustive {
		t.Fatal("want non-exhaustive")
	}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, []string{"Green"}) {
		t.Fatalf("uncovered = %v, want [Green]", got)
	}
}

func TestUnreachableDuplicate(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Lit("Red")},
		{Pattern: Wild()},
	}, Options{})
	if !reflect.DeepEqual(rep.Unreachable, []int{1}) {
		t.Fatalf("unreachable = %v, want [1]", rep.Unreachable)
	}
	if !rep.Exhaustive {
		t.Fatal("want exhaustive via wildcard")
	}
}

func TestWildcardShadowsRest(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Wild()},
		{Pattern: Lit("Green")},
	}, Options{})
	if !reflect.DeepEqual(rep.Unreachable, []int{2}) {
		t.Fatalf("unreachable = %v, want [2]", rep.Unreachable)
	}
	if !rep.Exhaustive {
		t.Fatal("want exhaustive")
	}
}

func TestGuardDoesNotCover(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Lit("Green"), Guard: true},
		{Pattern: Lit("Blue")},
	}, Options{})
	if rep.Exhaustive {
		t.Fatal("guarded branch must not count toward coverage")
	}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, []string{"Green"}) {
		t.Fatalf("uncovered = %v, want [Green]", got)
	}
	if len(rep.Unreachable) != 0 {
		t.Fatalf("guarded branch is still reachable, got %v", rep.Unreachable)
	}
}

func TestGuardedBranchUnreachable(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Lit("Red"), Guard: true},
		{Pattern: Wild()},
	}, Options{})
	if !reflect.DeepEqual(rep.Unreachable, []int{1}) {
		t.Fatalf("unreachable = %v, want [1]", rep.Unreachable)
	}
}

func TestGuardedWildcardNotExhaustive(t *testing.T) {
	rep := Analyze(color, []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Wild(), Guard: true},
	}, Options{})
	if rep.Exhaustive {
		t.Fatal("guarded wildcard must not imply exhaustiveness")
	}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, []string{"Green", "Blue"}) {
		t.Fatalf("uncovered = %v, want [Green Blue]", got)
	}
}

func TestTupleMinimalUncovered(t *testing.T) {
	boolean := Enum("Bool", "False", "True")
	pair := Tuple(boolean, color)
	rep := Analyze(pair, []Branch{
		{Pattern: TuplePat(Lit("True"), Wild())},
		{Pattern: TuplePat(Wild(), Lit("Green"))},
	}, Options{})
	if rep.Exhaustive || !rep.Enumerated {
		t.Fatalf("want non-exhaustive enumerated, got %+v", rep)
	}
	want := []string{"(False, Red)", "(False, Blue)"}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, want) {
		t.Fatalf("uncovered = %v, want %v", got, want)
	}
}

func TestTupleExhaustive(t *testing.T) {
	boolean := Enum("Bool", "False", "True")
	pair := Tuple(boolean, color)
	rep := Analyze(pair, []Branch{
		{Pattern: TuplePat(Lit("True"), Wild())},
		{Pattern: TuplePat(Lit("False"), Lit("Red"))},
		{Pattern: TuplePat(Lit("False"), Lit("Green"))},
		{Pattern: TuplePat(Lit("False"), Lit("Blue"))},
	}, Options{})
	if !rep.Exhaustive {
		t.Fatalf("want exhaustive, uncovered=%v", valueStrings(rep.Uncovered))
	}
}

func TestNestedTuple(t *testing.T) {
	boolean := Enum("Bool", "False", "True")
	nested := Tuple(boolean, Tuple(color, boolean))
	rep := Analyze(nested, []Branch{
		{Pattern: TuplePat(Wild(), TuplePat(Wild(), Lit("True")))},
		{Pattern: TuplePat(Lit("False"), Wild())},
	}, Options{})
	if rep.Exhaustive {
		t.Fatal("want non-exhaustive")
	}
	want := []string{"(True, (Red, False))", "(True, (Green, False))", "(True, (Blue, False))"}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, want) {
		t.Fatalf("uncovered = %v, want %v", got, want)
	}
}

func TestUnknownNeverExhaustiveByLiterals(t *testing.T) {
	rep := Analyze(Unknown(), []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Lit("Green")},
	}, Options{})
	if rep.Exhaustive || rep.Enumerated {
		t.Fatalf("unknown type must not be called exhaustive, got %+v", rep)
	}
	if len(rep.Uncovered) != 0 {
		t.Fatalf("no witnesses available for unknown type, got %v", rep.Uncovered)
	}
}

func TestUnknownWithCatchAll(t *testing.T) {
	rep := Analyze(Unknown(), []Branch{
		{Pattern: Lit("Red")},
		{Pattern: Wild()},
		{Pattern: Lit("Green")},
	}, Options{})
	if !rep.Exhaustive || rep.Enumerated {
		t.Fatalf("want structurally exhaustive but not enumerated, got %+v", rep)
	}
	if !reflect.DeepEqual(rep.Unreachable, []int{2}) {
		t.Fatalf("unreachable = %v, want [2]", rep.Unreachable)
	}
}

func TestUnknownGuardedCatchAllNotExhaustive(t *testing.T) {
	rep := Analyze(Unknown(), []Branch{
		{Pattern: Wild(), Guard: true},
	}, Options{})
	if rep.Exhaustive {
		t.Fatal("guarded catch-all over unknown type must not be exhaustive")
	}
}

func TestBudgetExceededFallsBack(t *testing.T) {
	big := make([]string, 100)
	for i := range big {
		big[i] = string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	e := Enum("Big", big...)
	pair := Tuple(e, e) // 10_000 values > budget
	rep := Analyze(pair, []Branch{
		{Pattern: TuplePat(Wild(), Wild())},
		{Pattern: TuplePat(Lit(big[0]), Lit(big[0]))},
	}, Options{Budget: 500})
	if rep.Enumerated {
		t.Fatal("budget exceeded: must not enumerate")
	}
	if !rep.Exhaustive {
		t.Fatal("tuple of wildcards is a catch-all")
	}
	if !reflect.DeepEqual(rep.Unreachable, []int{1}) {
		t.Fatalf("unreachable = %v, want [1]", rep.Unreachable)
	}
}

func TestBudgetExceededNoCatchAll(t *testing.T) {
	big := make([]string, 100)
	for i := range big {
		big[i] = string(rune('A' + i))
	}
	e := Enum("Big", big...)
	rep := Analyze(Tuple(e, e), []Branch{
		{Pattern: TuplePat(Lit(big[0]), Wild())},
	}, Options{Budget: 500})
	if rep.Exhaustive || rep.Enumerated {
		t.Fatalf("want neither exhaustive nor enumerated, got %+v", rep)
	}
}

func TestUncoveredLimitAndOrder(t *testing.T) {
	e := Enum("E", "V1", "V2", "V3", "V4", "V5")
	rep := Analyze(e, nil, Options{MaxUncovered: 3})
	if rep.Exhaustive {
		t.Fatal("empty branch list cannot be exhaustive")
	}
	want := []string{"V1", "V2", "V3"}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, want) {
		t.Fatalf("uncovered = %v, want minimal %v", got, want)
	}
}

func TestEnumDeclarationOrderIsMinimal(t *testing.T) {
	e := Enum("E", "Zeta", "Alpha", "Mid")
	rep := Analyze(e, []Branch{{Pattern: Lit("Mid")}}, Options{})
	want := []string{"Zeta", "Alpha"}
	if got := valueStrings(rep.Uncovered); !reflect.DeepEqual(got, want) {
		t.Fatalf("uncovered = %v, want declaration order %v", got, want)
	}
}

func TestTuplePatternArityMismatch(t *testing.T) {
	boolean := Enum("Bool", "False", "True")
	rep := Analyze(Tuple(boolean, boolean), []Branch{
		{Pattern: TuplePat(Wild())}, // arity mismatch: matches nothing
	}, Options{})
	if !reflect.DeepEqual(rep.Unreachable, []int{0}) {
		t.Fatalf("unreachable = %v, want [0]", rep.Unreachable)
	}
	if rep.Exhaustive {
		t.Fatal("want non-exhaustive")
	}
}
