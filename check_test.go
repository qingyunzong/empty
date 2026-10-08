package matchcheck

import (
	"reflect"
	"testing"
)

var boolT = Enum{Name: "Bool", Variants: []string{"False", "True"}}

func v(name string) Pattern        { return Variant{Name: name} }
func tup(elems ...Pattern) Pattern { return TuplePat{Elems: elems} }
func wild() Pattern                { return Wildcard{} }

func unguarded(p Pattern) Branch { return Branch{Pattern: p} }
func guarded(p Pattern) Branch   { return Branch{Pattern: p, HasGuard: true} }

func TestMissingVariantReported(t *testing.T) {
	rep, err := Check(boolT, []Branch{unguarded(v("True"))}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Exhaustive {
		t.Fatal("expected non-exhaustive")
	}
	want := []Pattern{v("False")}
	if !reflect.DeepEqual(rep.Uncovered, want) {
		t.Fatalf("uncovered = %v, want %v", rep.Uncovered, want)
	}
	if !rep.EnumVerified {
		t.Fatal("small enum should be verified by enumeration")
	}
}

func TestWildcardExhaustive(t *testing.T) {
	rep, err := Check(boolT, []Branch{unguarded(v("True")), unguarded(wild())}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Exhaustive || len(rep.Uncovered) != 0 {
		t.Fatalf("expected exhaustive, got %+v", rep)
	}
}

func TestUnreachableBranch(t *testing.T) {
	rep, err := Check(boolT, []Branch{
		unguarded(wild()),
		unguarded(v("True")),
	}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rep.Unreachable, []int{1}) {
		t.Fatalf("unreachable = %v, want [1]", rep.Unreachable)
	}
	if !rep.Exhaustive {
		t.Fatal("expected exhaustive")
	}
}

func TestGuardDoesNotCover(t *testing.T) {
	// A guarded branch must not make the match exhaustive, and a later
	// unguarded branch on the same value must stay reachable.
	rep, err := Check(boolT, []Branch{
		guarded(v("True")),
		unguarded(v("True")),
	}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Unreachable) != 0 {
		t.Fatalf("branch 1 must be reachable behind a guard, got %v", rep.Unreachable)
	}
	if rep.Exhaustive {
		t.Fatal("guard must not guarantee coverage of True")
	}
	want := []Pattern{v("False")}
	if !reflect.DeepEqual(rep.Uncovered, want) {
		t.Fatalf("uncovered = %v, want %v", rep.Uncovered, want)
	}
}

func TestGuardedBranchUnreachableWhenAlreadyCovered(t *testing.T) {
	rep, err := Check(boolT, []Branch{
		unguarded(wild()),
		guarded(v("False")),
	}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rep.Unreachable, []int{1}) {
		t.Fatalf("unreachable = %v, want [1]", rep.Unreachable)
	}
}

func TestTupleWitnesses(t *testing.T) {
	pair := Tuple{Elems: []Type{boolT, boolT}}
	rep, err := Check(pair, []Branch{
		unguarded(tup(v("True"), wild())),
		unguarded(tup(wild(), v("False"))),
	}, 64)
	if err != nil {
		t.Fatal(err)
	}
	want := []Pattern{tup(v("False"), v("True"))}
	if !reflect.DeepEqual(rep.Uncovered, want) {
		t.Fatalf("uncovered = %v, want %v", rep.Uncovered, want)
	}
	if rep.Exhaustive {
		t.Fatal("expected non-exhaustive")
	}
}

func TestNestedTuple(t *testing.T) {
	nested := Tuple{Elems: []Type{boolT, Tuple{Elems: []Type{boolT, boolT}}}}
	rep, err := Check(nested, []Branch{
		unguarded(tup(wild(), tup(wild(), v("True")))),
		unguarded(tup(v("False"), wild())),
	}, 64)
	if err != nil {
		t.Fatal(err)
	}
	want := []Pattern{tup(v("True"), tup(wild(), v("False")))}
	if !reflect.DeepEqual(rep.Uncovered, want) {
		t.Fatalf("uncovered = %v, want %v", rep.Uncovered, want)
	}
}

func TestTupleExhaustiveAndRedundant(t *testing.T) {
	pair := Tuple{Elems: []Type{boolT, boolT}}
	rep, err := Check(pair, []Branch{
		unguarded(tup(v("True"), wild())),
		unguarded(tup(v("False"), wild())),
		unguarded(tup(v("False"), v("False"))),
	}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Exhaustive {
		t.Fatalf("expected exhaustive, uncovered = %v", rep.Uncovered)
	}
	if !reflect.DeepEqual(rep.Unreachable, []int{2}) {
		t.Fatalf("unreachable = %v, want [2]", rep.Unreachable)
	}
}

func TestUnknownNeverExhaustive(t *testing.T) {
	rep, err := Check(Unknown{}, []Branch{unguarded(wild())}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Exhaustive {
		t.Fatal("unknown type must never be exhaustive")
	}
	if !rep.ContainsUnknown {
		t.Fatal("expected ContainsUnknown")
	}
	if rep.EnumVerified {
		t.Fatal("unknown type cannot be enumerated")
	}
}

func TestNestedUnknownNeverExhaustive(t *testing.T) {
	mixed := Tuple{Elems: []Type{boolT, Unknown{}}}
	rep, err := Check(mixed, []Branch{unguarded(wild())}, 64)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Exhaustive || !rep.ContainsUnknown {
		t.Fatalf("nested unknown must block exhaustiveness, got %+v", rep)
	}
}

func TestBudgetExceeded(t *testing.T) {
	big := Enum{Name: "Big", Variants: []string{"A", "B", "C", "D", "E"}}
	// Matching one variant leaves 4 witnesses; budget 3 must trip.
	rep, err := Check(big, []Branch{unguarded(v("A"))}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.OverBudget {
		t.Fatal("expected OverBudget")
	}
	if rep.Exhaustive {
		t.Fatal("over-budget match must not be exhaustive")
	}
	if rep.EnumVerified {
		t.Fatal("over-budget match must skip enumeration")
	}
}

func TestLargeTypeSkipsEnumeration(t *testing.T) {
	big := Enum{Name: "Big", Variants: []string{"A", "B", "C", "D", "E"}}
	// A wildcard still proves exhaustiveness by subtraction, but the
	// 5-value enum exceeds budget 3 so no enumeration happens.
	rep, err := Check(big, []Branch{unguarded(wild())}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Exhaustive {
		t.Fatal("wildcard must be exhaustive even for large types")
	}
	if rep.EnumVerified {
		t.Fatal("type larger than budget must not be enumerated")
	}
}

func TestBudgetSufficient(t *testing.T) {
	big := Enum{Name: "Big", Variants: []string{"A", "B", "C"}}
	rep, err := Check(big, []Branch{unguarded(v("A"))}, 8)
	if err != nil {
		t.Fatal(err)
	}
	if rep.OverBudget {
		t.Fatal("budget 8 should suffice for 3-variant enum")
	}
	want := []Pattern{v("B"), v("C")}
	if !reflect.DeepEqual(rep.Uncovered, want) {
		t.Fatalf("uncovered = %v, want %v", rep.Uncovered, want)
	}
}

func TestSingleVariantEnum(t *testing.T) {
	unit := Enum{Name: "Unit", Variants: []string{"Unit"}}
	rep, err := Check(unit, []Branch{unguarded(v("Unit"))}, 4)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Exhaustive {
		t.Fatal("single-variant enum fully matched should be exhaustive")
	}
}

func TestIllTypedPatterns(t *testing.T) {
	cases := []Branch{
		unguarded(v("Nope")),
		unguarded(tup(wild())),
	}
	for _, b := range cases {
		if _, err := Check(boolT, []Branch{b}, 8); err == nil {
			t.Fatalf("expected validation error for %v", b.Pattern)
		}
	}
	if _, err := Check(boolT, []Branch{unguarded(tup(wild(), wild(), wild()))}, 8); err == nil {
		t.Fatal("expected arity mismatch error")
	}
}

// TestEnumerationCrossCheck fuzzes small tuples: for every subset of
// branches drawn from a fixed pool, the witness set must agree with a
// brute-force value scan (already asserted inside Check via EnumVerified,
// here we additionally check the uncovered value count directly).
func TestEnumerationCrossCheck(t *testing.T) {
	pair := Tuple{Elems: []Type{boolT, boolT}}
	pool := []Pattern{
		tup(v("True"), wild()),
		tup(wild(), v("False")),
		tup(v("False"), v("True")),
	}
	for mask := 0; mask < 1<<len(pool); mask++ {
		var branches []Branch
		for i, p := range pool {
			if mask&(1<<i) != 0 {
				branches = append(branches, unguarded(p))
			}
		}
		rep, err := Check(pair, branches, 16)
		if err != nil {
			t.Fatalf("mask %d: %v", mask, err)
		}
		if !rep.EnumVerified {
			t.Fatalf("mask %d: expected enumeration verification", mask)
		}
		// Count values matched by witnesses directly.
		count := 0
		for _, val := range enumerate(pair) {
			for _, w := range rep.Uncovered {
				if matches(w, val) {
					count++
					break
				}
			}
		}
		uncoveredVals := 0
		for _, val := range enumerate(pair) {
			matched := false
			for _, b := range branches {
				if matches(b.Pattern, val) {
					matched = true
					break
				}
			}
			if !matched {
				uncoveredVals++
			}
		}
		if count != uncoveredVals {
			t.Fatalf("mask %d: witnesses cover %d values, brute force says %d", mask, count, uncoveredVals)
		}
	}
}
