package policy

import (
	"fmt"
	"reflect"
	"testing"
)

// dimOption is one variant of an object dimension.
type dimOption struct {
	name  string
	apply func(obj map[string]any)
}

func ensurePath(obj map[string]any, keys ...string) map[string]any {
	cur := obj
	for _, k := range keys {
		next, ok := cur[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[k] = next
		}
		cur = next
	}
	return cur
}

var labelsDim = []dimOption{
	{"absent", func(obj map[string]any) {}},
	{"null", func(obj map[string]any) { ensurePath(obj, "metadata")["labels"] = nil }},
	{"empty", func(obj map[string]any) { ensurePath(obj, "metadata")["labels"] = map[string]any{} }},
	{"app-a", func(obj map[string]any) { ensurePath(obj, "metadata")["labels"] = map[string]any{"app": "a"} }},
	{"app-b", func(obj map[string]any) { ensurePath(obj, "metadata")["labels"] = map[string]any{"app": "b"} }},
	{"app-a-env-x", func(obj map[string]any) {
		ensurePath(obj, "metadata")["labels"] = map[string]any{"app": "a", "env": "x"}
	}},
	{"env-y", func(obj map[string]any) { ensurePath(obj, "metadata")["labels"] = map[string]any{"env": "y"} }},
	{"nonmap", func(obj map[string]any) { ensurePath(obj, "metadata")["labels"] = "weird" }},
}

var replicasDim = []dimOption{
	{"absent", func(obj map[string]any) {}},
	{"null", func(obj map[string]any) { ensurePath(obj, "spec")["replicas"] = nil }},
	{"zero", func(obj map[string]any) { ensurePath(obj, "spec")["replicas"] = 0 }},
	{"one", func(obj map[string]any) { ensurePath(obj, "spec")["replicas"] = 1 }},
	{"three", func(obj map[string]any) { ensurePath(obj, "spec")["replicas"] = 3 }},
}

var containersDim = []dimOption{
	{"absent", func(obj map[string]any) {}},
	{"null", func(obj map[string]any) { ensurePath(obj, "spec")["containers"] = nil }},
	{"empty", func(obj map[string]any) { ensurePath(obj, "spec")["containers"] = []any{} }},
	{"one", func(obj map[string]any) {
		ensurePath(obj, "spec")["containers"] = []any{
			map[string]any{"name": "web", "image": "img:1", "ports": []any{80}},
		}
	}},
	{"two", func(obj map[string]any) {
		ensurePath(obj, "spec")["containers"] = []any{
			map[string]any{"name": "web", "image": "img:1", "ports": []any{80}},
			map[string]any{"name": "db", "image": "img:2"},
		}
	}},
	{"nonlist", func(obj map[string]any) { ensurePath(obj, "spec")["containers"] = "nope" }},
}

var tierDim = []dimOption{
	{"absent", func(obj map[string]any) {}},
	{"null", func(obj map[string]any) { ensurePath(obj, "spec")["tier"] = nil }},
	{"gold", func(obj map[string]any) { ensurePath(obj, "spec")["tier"] = "gold" }},
	{"silver", func(obj map[string]any) { ensurePath(obj, "spec")["tier"] = "silver" }},
}

// objectSpace enumerates the full cross product of the dimensions.
func objectSpace() []map[string]any {
	var objects []map[string]any
	for _, l := range labelsDim {
		for _, r := range replicasDim {
			for _, c := range containersDim {
				for _, t := range tierDim {
					obj := map[string]any{}
					l.apply(obj)
					r.apply(obj)
					c.apply(obj)
					t.apply(obj)
					objects = append(objects, obj)
				}
			}
		}
	}
	return objects
}

// ruleSpace enumerates the rule expressions under test.
func ruleSpace() []Expr {
	pred := func(op Op, value any, path ...string) Pred {
		return Pred{Path: path, Op: op, Value: value}
	}
	base := []Expr{
		pred(OpEq, "a", "metadata", "labels", "app"),
		pred(OpNotEq, "a", "metadata", "labels", "app"),
		pred(OpIn, []any{"a", "b"}, "metadata", "labels", "app"),
		pred(OpNotIn, []any{"a"}, "metadata", "labels", "app"),
		pred(OpExists, nil, "metadata", "labels", "app"),
		pred(OpNotExists, nil, "metadata", "labels", "app"),
		pred(OpIsNull, nil, "metadata", "labels", "app"),
		pred(OpIsNotNull, nil, "metadata", "labels", "app"),
		pred(OpEq, 1, "spec", "replicas"),
		pred(OpGt, 1, "spec", "replicas"),
		pred(OpGte, 1, "spec", "replicas"),
		pred(OpLt, 3, "spec", "replicas"),
		pred(OpLte, 0, "spec", "replicas"),
		pred(OpIsNull, nil, "spec", "replicas"),
		pred(OpNotExists, nil, "spec", "replicas"),
		pred(OpEq, "gold", "spec", "tier"),
		pred(OpMatches, "^g", "spec", "tier"),
		pred(OpIn, []any{"gold", "silver"}, "spec", "tier"),
		pred(OpIsNull, nil, "spec", "tier"),
		pred(OpExists, nil, "spec", "containers"),
		Selector{MatchLabels: map[string]string{"app": "a"}},
		Selector{MatchLabels: map[string]string{"app": "a", "env": "x"}},
		Selector{MatchExpressions: []SelectorExpr{{Key: "app", Operator: SelectorIn, Values: []string{"a", "b"}}}},
		Selector{MatchExpressions: []SelectorExpr{{Key: "app", Operator: SelectorNotIn, Values: []string{"a"}}}},
		Selector{MatchExpressions: []SelectorExpr{{Key: "env", Operator: SelectorExists}}},
		Selector{MatchExpressions: []SelectorExpr{{Key: "env", Operator: SelectorDoesNotExist}}},
		Selector{},
		Selector{
			MatchLabels:      map[string]string{"app": "a"},
			MatchExpressions: []SelectorExpr{{Key: "env", Operator: SelectorIn, Values: []string{"x"}}},
		},
		Quantifier{Kind: ForAll, Path: []string{"spec", "containers"},
			Item: pred(OpExists, nil, "name")},
		Quantifier{Kind: Exists, Path: []string{"spec", "containers"},
			Item: pred(OpEq, "web", "name")},
		Quantifier{Kind: ForAll, Path: []string{"spec", "containers"},
			Item: pred(OpMatches, ":1$", "image")},
		Quantifier{Kind: Exists, Path: []string{"spec", "containers"},
			Item: pred(OpExists, nil, "ports")},
		Quantifier{Kind: Exists, Path: []string{"spec", "containers"},
			Item: pred(OpEq, "no-such-name", "name")},
		Quantifier{Kind: ForAll, Path: []string{"spec", "containers"},
			Item: And{Args: []Expr{pred(OpExists, nil, "name"), pred(OpExists, nil, "image")}}},
	}
	logical := []Expr{
		And{Args: []Expr{base[0], base[8]}},
		Or{Args: []Expr{base[0], base[15]}},
		Not{Arg: base[0]},
		And{Args: []Expr{Or{Args: []Expr{base[0], base[1]}}, Not{Arg: base[13]}}},
		And{},
		Or{},
		Not{Arg: And{Args: []Expr{base[28], base[15]}}},
	}
	return append(base, logical...)
}

func makeRules(exprs []Expr) []Rule {
	rules := make([]Rule, len(exprs))
	for i, expr := range exprs {
		rules[i] = Rule{ID: fmt.Sprintf("r%03d", i), When: expr}
	}
	return rules
}

func assertDecisionEqual(t *testing.T, context string, got, want Decision) {
	t.Helper()
	if got.Allowed != want.Allowed {
		t.Fatalf("%s: allowed mismatch: got %v want %v", context, got.Allowed, want.Allowed)
	}
	if !reflect.DeepEqual(got.Reasons, want.Reasons) {
		t.Fatalf("%s: reasons mismatch:\n got %+v\nwant %+v", context, got.Reasons, want.Reasons)
	}
}

// TestExhaustiveSingleRule compiles every rule in the rule space into a
// one-rule plan and checks every object in the object space against the
// naive per-predicate re-evaluation, for both evaluation modes.
func TestExhaustiveSingleRule(t *testing.T) {
	objects := objectSpace()
	exprs := ruleSpace()
	for i, expr := range exprs {
		rules := makeRules([]Expr{expr})
		plan, err := Compile(rules)
		if err != nil {
			t.Fatalf("rule %d: compile: %v", i, err)
		}
		for j, obj := range objects {
			want := naiveDecision(rules, obj)
			ctx := fmt.Sprintf("rule %d object %d", i, j)
			assertDecisionEqual(t, ctx+" EvaluateAll", plan.EvaluateAll(obj), want)
			short := plan.Evaluate(obj)
			if short.Allowed != want.Allowed {
				t.Fatalf("%s Evaluate: allowed mismatch: got %v want %v", ctx, short.Allowed, want.Allowed)
			}
			if !want.Allowed {
				wantShort := Decision{Allowed: false, Reasons: want.Reasons[:1]}
				assertDecisionEqual(t, ctx+" Evaluate", short, wantShort)
			}
		}
	}
}

// TestExhaustiveMultiRule enumerates every plan of up to three rules
// drawn from a representative subset and checks merged decisions and
// reason sets against the naive reference.
func TestExhaustiveMultiRule(t *testing.T) {
	objects := objectSpace()
	exprs := ruleSpace()
	// Representative subset covering every expression kind.
	pick := []int{0, 4, 6, 8, 9, 13, 15, 16, 20, 22, 24, 28, 29, 34, 36}
	var subset []Expr
	for _, idx := range pick {
		subset = append(subset, exprs[idx])
	}
	n := len(subset)
	var plans [][]Expr
	for a := 0; a < n; a++ {
		plans = append(plans, []Expr{subset[a]})
		for b := a + 1; b < n; b++ {
			plans = append(plans, []Expr{subset[a], subset[b]})
			for c := b + 1; c < n; c++ {
				plans = append(plans, []Expr{subset[a], subset[b], subset[c]})
			}
		}
	}
	for pi, combo := range plans {
		rules := makeRules(combo)
		plan, err := Compile(rules)
		if err != nil {
			t.Fatalf("plan %d: compile: %v", pi, err)
		}
		for j, obj := range objects {
			want := naiveDecision(rules, obj)
			ctx := fmt.Sprintf("plan %d object %d", pi, j)
			assertDecisionEqual(t, ctx+" EvaluateAll", plan.EvaluateAll(obj), want)
			short := plan.Evaluate(obj)
			if short.Allowed != want.Allowed {
				t.Fatalf("%s Evaluate: allowed mismatch: got %v want %v", ctx, short.Allowed, want.Allowed)
			}
			if !want.Allowed {
				wantShort := Decision{Allowed: false, Reasons: want.Reasons[:1]}
				assertDecisionEqual(t, ctx+" Evaluate", short, wantShort)
			}
		}
	}
}

// TestEvaluationIsPure verifies that evaluation never mutates the
// evaluated object, so short-circuiting cannot leave side effects.
func TestEvaluationIsPure(t *testing.T) {
	rules := makeRules(ruleSpace())
	plan, err := Compile(rules)
	if err != nil {
		t.Fatal(err)
	}
	for i, obj := range objectSpace() {
		snapshot := deepCopyValue(obj)
		plan.Evaluate(obj)
		plan.EvaluateAll(obj)
		if !reflect.DeepEqual(obj, snapshot) {
			t.Fatalf("object %d mutated by evaluation", i)
		}
	}
}
