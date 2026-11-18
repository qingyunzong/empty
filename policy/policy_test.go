package policy

import "testing"

func evalOne(t *testing.T, expr Expr, obj any) bool {
	t.Helper()
	plan, err := Compile([]Rule{{ID: "r", When: expr}})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return !plan.Evaluate(obj).Allowed
}

func TestQuantifierEmptySet(t *testing.T) {
	emptyList := map[string]any{"spec": map[string]any{"containers": []any{}}}
	forAll := Quantifier{Kind: ForAll, Path: []string{"spec", "containers"},
		Item: Pred{Path: []string{"name"}, Op: OpExists}}
	exists := Quantifier{Kind: Exists, Path: []string{"spec", "containers"},
		Item: Pred{Path: []string{"name"}, Op: OpExists}}

	if !evalOne(t, forAll, emptyList) {
		t.Error("ForAll over empty set must be vacuously true")
	}
	if evalOne(t, exists, emptyList) {
		t.Error("Exists over empty set must be false")
	}
}

func TestQuantifierMissingNullNonList(t *testing.T) {
	forAll := Quantifier{Kind: ForAll, Path: []string{"spec", "containers"},
		Item: Pred{Path: []string{"name"}, Op: OpExists}}
	cases := map[string]any{
		"missing":  map[string]any{"spec": map[string]any{}},
		"null":     map[string]any{"spec": map[string]any{"containers": nil}},
		"non-list": map[string]any{"spec": map[string]any{"containers": "nope"}},
	}
	for name, obj := range cases {
		if evalOne(t, forAll, obj) {
			t.Errorf("ForAll over %s collection must be false (not vacuous)", name)
		}
	}
}

func TestMissingVersusNull(t *testing.T) {
	missing := map[string]any{"spec": map[string]any{}}
	null := map[string]any{"spec": map[string]any{"replicas": nil}}
	valued := map[string]any{"spec": map[string]any{"replicas": 2}}
	path := []string{"spec", "replicas"}

	table := []struct {
		op                    Op
		missing, null, valued bool
	}{
		{OpExists, false, true, true},
		{OpNotExists, true, false, false},
		{OpIsNull, false, true, false},
		{OpIsNotNull, false, false, true},
		{OpEq, false, false, false}, // Eq 3: false everywhere here
	}
	for _, row := range table {
		pred := Pred{Path: path, Op: row.op, Value: 3}
		if got := evalOne(t, pred, missing); got != row.missing {
			t.Errorf("op %d on missing: got %v want %v", row.op, got, row.missing)
		}
		if got := evalOne(t, pred, null); got != row.null {
			t.Errorf("op %d on null: got %v want %v", row.op, got, row.null)
		}
		if got := evalOne(t, pred, valued); got != row.valued {
			t.Errorf("op %d on value: got %v want %v", row.op, got, row.valued)
		}
	}
	// Explicit null equals an explicit null comparison value.
	if !evalOne(t, Pred{Path: path, Op: OpEq, Value: nil}, null) {
		t.Error("Eq nil must match an explicit null")
	}
	if evalOne(t, Pred{Path: path, Op: OpEq, Value: nil}, missing) {
		t.Error("Eq nil must not match a missing field")
	}
}

func TestShortCircuitAndMerge(t *testing.T) {
	obj := map[string]any{"spec": map[string]any{"replicas": 5}}
	rules := []Rule{
		{ID: "b-second", When: Pred{Path: []string{"spec", "replicas"}, Op: OpGt, Value: 1}, Reason: "too many"},
		{ID: "a-first", When: Pred{Path: []string{"spec", "replicas"}, Op: OpExists}, Reason: "replicas present"},
		{ID: "c-third", When: Pred{Path: []string{"spec", "replicas"}, Op: OpLt, Value: 1}, Reason: "too few"},
	}
	plan, err := Compile(rules)
	if err != nil {
		t.Fatal(err)
	}

	short := plan.Evaluate(obj)
	if short.Allowed || len(short.Reasons) != 1 || short.Reasons[0].RuleID != "b-second" {
		t.Fatalf("short-circuit must stop at the first matched rule, got %+v", short)
	}

	merged := plan.EvaluateAll(obj)
	if merged.Allowed {
		t.Fatal("any matching deny rule must reject the whole")
	}
	if len(merged.Reasons) != 2 ||
		merged.Reasons[0].RuleID != "b-second" ||
		merged.Reasons[1].RuleID != "a-first" {
		t.Fatalf("merged reasons must follow stable rule order, got %+v", merged.Reasons)
	}

	allowed := plan.EvaluateAll(map[string]any{"spec": map[string]any{}})
	if !allowed.Allowed || len(allowed.Reasons) != 0 {
		t.Fatalf("no matched rule must allow, got %+v", allowed)
	}
}

func TestCompileValidation(t *testing.T) {
	bad := [][]Rule{
		{{ID: "x"}, {ID: "x", When: And{}}}, // duplicate IDs (first invalid too)
		{{ID: "", When: And{}}},             // empty ID
		{{ID: "x"}},                         // nil When
		{{ID: "x", When: Pred{Path: []string{"a"}, Op: Op(99)}}}, // bad op
		{{ID: "x", When: Pred{Path: []string{"a"}, Op: OpIn, Value: "notalist"}}},
		{{ID: "x", When: Pred{Path: []string{"a"}, Op: OpMatches, Value: "["}}},
		{{ID: "x", When: Quantifier{Kind: ForAll, Path: nil, Item: And{}}}},
		{{ID: "x", When: Quantifier{Kind: Exists, Path: []string{"a"}}}},
		{{ID: "x", When: Selector{MatchExpressions: []SelectorExpr{{Key: "k", Operator: SelectorIn}}}}},
	}
	for i, rules := range bad {
		if _, err := Compile(rules); err == nil {
			t.Errorf("case %d: expected compile error", i)
		}
	}
}
