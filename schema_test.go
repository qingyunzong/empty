package dataeng

import (
	"encoding/json"
	"strings"
	"testing"
)

func ptrInt64(value int64) *int64 { return &value }

func ptrInt(value int) *int { return &value }

func mustCompile(t *testing.T, root Schema, defs map[string]Schema) Validator {
	t.Helper()
	validator, err := Compile(root, defs)
	if err != nil {
		t.Fatalf("Compile returned unexpected error: %v", err)
	}
	return validator
}

func TestPrimitiveSchemas(t *testing.T) {
	tests := []struct {
		name       string
		schema     Schema
		value      any
		wantFail   bool
		wantReason string
	}{
		{name: "null accepts nil", schema: &Null{}, value: nil},
		{name: "null rejects bool", schema: &Null{}, value: true, wantFail: true, wantReason: ReasonNotNull},
		{name: "boolean accepts true", schema: &Boolean{}, value: true},
		{name: "boolean rejects string", schema: &Boolean{}, value: "x", wantFail: true, wantReason: ReasonNotBoolean},
		{name: "integer accepts int64 in range", schema: &Integer{Min: ptrInt64(1), Max: ptrInt64(10)}, value: int64(5)},
		{name: "integer accepts json number", schema: &Integer{}, value: json.Number("42")},
		{name: "integer rejects fractional", schema: &Integer{}, value: 1.5, wantFail: true, wantReason: ReasonNotInteger},
		{name: "integer rejects below min", schema: &Integer{Min: ptrInt64(1)}, value: int64(0), wantFail: true, wantReason: ReasonIntegerRange},
		{name: "integer rejects above max", schema: &Integer{Max: ptrInt64(3)}, value: int64(4), wantFail: true, wantReason: ReasonIntegerRange},
		{name: "integer rejects overflow", schema: &Integer{}, value: uint64(1) << 63, wantFail: true, wantReason: ReasonNotInteger},
		{name: "string accepts enum member", schema: &String{Enumeration: []string{"a", "b"}}, value: "b"},
		{name: "string rejects outsider", schema: &String{Enumeration: []string{"a"}}, value: "b", wantFail: true, wantReason: ReasonEnumMismatch},
		{name: "string rejects non string", schema: &String{Enumeration: []string{"a"}}, value: 1, wantFail: true, wantReason: ReasonNotString},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			validator := mustCompile(t, tt.schema, nil)
			failure := validator.Validate(tt.value)
			if tt.wantFail {
				if failure == nil {
					t.Fatalf("expected failure for value %#v", tt.value)
				}
				if failure.Trace.Reason != tt.wantReason {
					t.Fatalf("reason = %q, want %q", failure.Trace.Reason, tt.wantReason)
				}
			} else if failure != nil {
				t.Fatalf("unexpected failure: %v", failure)
			}
		})
	}
}

func TestObjectValidationAndPaths(t *testing.T) {
	schema := &Object{
		Properties: []ObjectProperty{
			{Name: "name", Schema: &String{Enumeration: []string{"alice", "bob"}}},
			{Name: "age", Schema: &Integer{Min: ptrInt64(0)}},
		},
		Required:             []string{"name"},
		AdditionalProperties: false,
	}
	validator := mustCompile(t, schema, nil)

	t.Run("valid object", func(t *testing.T) {
		value := map[string]any{"name": "alice", "age": int64(30)}
		if failure := validator.Validate(value); failure != nil {
			t.Fatalf("unexpected failure: %v", failure)
		}
	})

	t.Run("missing required field", func(t *testing.T) {
		failure := validator.Validate(map[string]any{"age": int64(1)})
		if failure == nil || failure.Trace.Reason != ReasonFieldFailed {
			t.Fatalf("got %v, want field failure", failure)
		}
		if got, want := failure.Path.String(), "$.name"; got != want {
			t.Fatalf("path = %q, want %q", got, want)
		}
		if reason := failure.Trace.Children[0].Reason; reason != ReasonMissingField {
			t.Fatalf("child reason = %q, want %q", reason, ReasonMissingField)
		}
	})

	t.Run("additional field rejected", func(t *testing.T) {
		failure := validator.Validate(map[string]any{"name": "alice", "extra": true})
		if failure == nil {
			t.Fatal("expected additional property failure")
		}
		if got, want := failure.Path.String(), "$.extra"; got != want {
			t.Fatalf("path = %q, want %q", got, want)
		}
	})

	t.Run("nested field failure path", func(t *testing.T) {
		nested := &Object{
			Properties: []ObjectProperty{
				{Name: "inner", Schema: &Object{
					Properties: []ObjectProperty{{Name: "n", Schema: &Integer{}}},
				}},
			},
		}
		nestedValidator := mustCompile(t, nested, nil)
		failure := nestedValidator.Validate(map[string]any{
			"inner": map[string]any{"n": "not an int"},
		})
		if failure == nil {
			t.Fatal("expected nested failure")
		}
		if got, want := failure.Path.String(), "$.inner.n"; got != want {
			t.Fatalf("path = %q, want %q", got, want)
		}
	})

	t.Run("additional properties allowed when enabled", func(t *testing.T) {
		open := &Object{
			Properties:           []ObjectProperty{{Name: "name", Schema: &String{Enumeration: []string{"alice"}}}},
			AdditionalProperties: true,
		}
		openValidator := mustCompile(t, open, nil)
		if failure := openValidator.Validate(map[string]any{"name": "alice", "extra": []any{1, 2}}); failure != nil {
			t.Fatalf("unexpected failure: %v", failure)
		}
	})
}

func TestArrayValidation(t *testing.T) {
	schema := &Array{
		Items:     &Integer{Min: ptrInt64(0)},
		MinLength: ptrInt(1),
		MaxLength: ptrInt(3),
	}
	validator := mustCompile(t, schema, nil)

	if failure := validator.Validate([]any{int64(1), int64(2)}); failure != nil {
		t.Fatalf("unexpected failure: %v", failure)
	}

	if failure := validator.Validate([]any{}); failure == nil ||
		failure.Trace.Children[0].Reason != ReasonArrayTooShort {
		t.Fatalf("expected too short failure, got %v", failure)
	}

	long := []any{int64(1), int64(2), int64(3), int64(4)}
	if failure := validator.Validate(long); failure == nil ||
		failure.Trace.Children[0].Reason != ReasonArrayTooLong {
		t.Fatalf("expected too long failure, got %v", failure)
	}

	failure := validator.Validate([]any{int64(1), int64(-1)})
	if failure == nil || failure.Trace.Reason != ReasonElementFailed {
		t.Fatalf("expected element failure, got %v", failure)
	}
	if got, want := failure.Path.String(), "$[1]"; got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}

	if failure := validator.Validate("not an array"); failure == nil ||
		failure.Trace.Reason != ReasonNotArray {
		t.Fatalf("expected not array failure, got %v", failure)
	}
}

func TestAnyOfVsOneOf(t *testing.T) {
	branches := []Schema{
		&Integer{Min: ptrInt64(1)},
		&Integer{Max: ptrInt64(10)},
	}
	value := int64(5) // matches both branches

	t.Run("anyOf passes when several branches match", func(t *testing.T) {
		validator := mustCompile(t, &AnyOf{Branches: branches}, nil)
		if failure := validator.Validate(value); failure != nil {
			t.Fatalf("anyOf rejected a value matching two branches: %v", failure)
		}
	})

	t.Run("oneOf fails when several branches match and evaluates all of them", func(t *testing.T) {
		validator := mustCompile(t, &OneOf{Branches: branches}, nil)
		failure := validator.Validate(value)
		if failure == nil || failure.Trace.Reason != ReasonOneOfMultiple {
			t.Fatalf("got %v, want %s", failure, ReasonOneOfMultiple)
		}
		if got := len(failure.Trace.Children); got != len(branches) {
			t.Fatalf("evaluated %d branches, want %d", got, len(branches))
		}
	})

	t.Run("oneOf passes with exactly one matching branch", func(t *testing.T) {
		validator := mustCompile(t, &OneOf{Branches: []Schema{&Boolean{}, &Integer{}}}, nil)
		if failure := validator.Validate(int64(7)); failure != nil {
			t.Fatalf("unexpected failure: %v", failure)
		}
	})

	t.Run("oneOf no match keeps full branch decision tree", func(t *testing.T) {
		validator := mustCompile(t, &OneOf{Branches: []Schema{&Boolean{}, &Null{}}}, nil)
		failure := validator.Validate("x")
		if failure == nil || failure.Trace.Reason != ReasonOneOfNoMatch {
			t.Fatalf("got %v, want %s", failure, ReasonOneOfNoMatch)
		}
		if got := len(failure.Trace.Children); got != 2 {
			t.Fatalf("branch tree size = %d, want 2", got)
		}
	})

	t.Run("anyOf no match", func(t *testing.T) {
		validator := mustCompile(t, &AnyOf{Branches: []Schema{&Boolean{}, &Null{}}}, nil)
		failure := validator.Validate("x")
		if failure == nil || failure.Trace.Reason != ReasonAnyOfNoMatch {
			t.Fatalf("got %v, want %s", failure, ReasonAnyOfNoMatch)
		}
	})

	t.Run("allOf requires every branch", func(t *testing.T) {
		validator := mustCompile(t, &AllOf{Branches: branches}, nil)
		if failure := validator.Validate(value); failure != nil {
			t.Fatalf("allOf should accept value satisfying every branch: %v", failure)
		}
		failure := validator.Validate(int64(11))
		if failure == nil || failure.Trace.Reason != ReasonAllOfFailed {
			t.Fatalf("got %v, want %s", failure, ReasonAllOfFailed)
		}
	})
}

func TestCompileRejectsGuardCycles(t *testing.T) {
	t.Run("direct reference cycle", func(t *testing.T) {
		defs := map[string]Schema{
			"loop": &Ref{Name: "loop"},
		}
		_, err := Compile(&Ref{Name: "loop"}, defs)
		if err == nil {
			t.Fatal("expected guard cycle error")
		}
		schemaErr, ok := err.(*SchemaError)
		if !ok || schemaErr.Reason != ReasonGuardCycle {
			t.Fatalf("error = %v, want reason %s", err, ReasonGuardCycle)
		}
		if !strings.Contains(err.Error(), "ref(loop)") {
			t.Fatalf("error message should name the cyclic node: %v", err)
		}
	})

	t.Run("oneOf branch reference cycle", func(t *testing.T) {
		defs := map[string]Schema{
			"pick": &OneOf{Branches: []Schema{&Boolean{}, &Ref{Name: "pick"}}},
		}
		_, err := Compile(&Ref{Name: "pick"}, defs)
		if err == nil {
			t.Fatal("expected cycle through oneOf branch to be rejected")
		}
	})

	t.Run("allOf and anyOf guard cycle", func(t *testing.T) {
		defs := map[string]Schema{
			"a": &AllOf{Branches: []Schema{&Ref{Name: "b"}}},
			"b": &AnyOf{Branches: []Schema{&Ref{Name: "a"}}},
		}
		if _, err := Compile(&Ref{Name: "a"}, defs); err == nil {
			t.Fatal("expected cycle through allOf/anyOf refs to be rejected")
		}
	})

	t.Run("cycle hidden behind array element is allowed", func(t *testing.T) {
		defs := map[string]Schema{
			"seq": &Array{Items: &Ref{Name: "seq"}},
		}
		if _, err := Compile(&Ref{Name: "seq"}, defs); err != nil {
			t.Fatalf("descent-edge recursion should be allowed: %v", err)
		}
	})
}

func TestCompileDefects(t *testing.T) {
	t.Run("nil root", func(t *testing.T) {
		_, err := Compile(nil, nil)
		if err == nil {
			t.Fatal("expected nil root error")
		}
	})

	t.Run("unresolved reference", func(t *testing.T) {
		_, err := Compile(&Ref{Name: "missing"}, map[string]Schema{})
		if err == nil {
			t.Fatal("expected unresolved reference error")
		}
		schemaErr := err.(*SchemaError)
		if schemaErr.Reason != ReasonUnresolvedRef {
			t.Fatalf("reason = %q, want %q", schemaErr.Reason, ReasonUnresolvedRef)
		}
	})

	t.Run("empty branches", func(t *testing.T) {
		if _, err := Compile(&OneOf{}, nil); err == nil {
			t.Fatal("expected empty branches error")
		}
	})

	t.Run("unknown required property", func(t *testing.T) {
		schema := &Object{Required: []string{"ghost"}}
		_, err := Compile(schema, nil)
		if err == nil {
			t.Fatal("expected unknown required property error")
		}
	})
}

func TestRecursionBehindDescentEdgesIsAllowed(t *testing.T) {
	// list = [null | list]; recursion only happens after descending into
	// array elements, so the guard-edge subgraph stays acyclic.
	defs := map[string]Schema{
		"list": &Array{
			Items: &AnyOf{Branches: []Schema{
				&Null{},
				&Ref{Name: "list"},
			}},
		},
	}
	validator := mustCompile(t, &Ref{Name: "list"}, defs)

	valid := []any{
		nil,
		[]any{nil, []any{nil}},
	}
	if failure := validator.Validate(valid); failure != nil {
		t.Fatalf("unexpected failure on recursive list: %v", failure)
	}

	failure := validator.Validate([]any{[]any{true}})
	if failure == nil {
		t.Fatal("expected failure from nested branch mismatch")
	}
	if got, want := failure.Path.String(), "$[0][0]"; got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestRefThroughObjectField(t *testing.T) {
	defs := map[string]Schema{
		"node": &Object{
			Properties: []ObjectProperty{
				{Name: "value", Schema: &Integer{}},
				{Name: "next", Schema: &Ref{Name: "node"}},
			},
		},
	}
	validator := mustCompile(t, &Ref{Name: "node"}, defs)

	value := map[string]any{
		"value": int64(1),
		"next": map[string]any{
			"value": "bad",
		},
	}
	failure := validator.Validate(value)
	if failure == nil {
		t.Fatal("expected nested ref failure")
	}
	if got, want := failure.Path.String(), "$.next.value"; got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}

	good := map[string]any{
		"value": int64(1),
		"next":  map[string]any{"value": int64(2)},
	}
	if failure := validator.Validate(good); failure != nil {
		t.Fatalf("unexpected failure: %v", failure)
	}
}

func TestCyclicValueRejected(t *testing.T) {
	validator := mustCompile(t, &Array{Items: &Integer{}}, nil)

	cyclicArray := []any{int64(1)}
	cyclicArray = append(cyclicArray, cyclicArray)
	failure := validator.Validate(cyclicArray)
	if failure == nil || failure.Trace.Reason != ReasonElementFailed {
		t.Fatalf("expected element failure wrapping cyclic value, got %v", failure)
	}

	validatorObject := mustCompile(t, &Object{
		Properties:           []ObjectProperty{{Name: "self", Schema: &Object{}}},
		AdditionalProperties: true,
	}, nil)
	cyclicObject := map[string]any{}
	cyclicObject["self"] = cyclicObject
	failure = validatorObject.Validate(cyclicObject)
	if failure == nil {
		t.Fatal("expected cyclic object failure")
	}
	if !strings.Contains(failure.Error(), ReasonCyclicValue) {
		t.Fatalf("error %q should contain %q", failure.Error(), ReasonCyclicValue)
	}
}

func TestDecisionTreeContainsAllBranches(t *testing.T) {
	schema := &OneOf{Branches: []Schema{
		&Object{Properties: []ObjectProperty{{Name: "kind", Schema: &String{Enumeration: []string{"a"}}}}},
		&Object{Properties: []ObjectProperty{{Name: "kind", Schema: &String{Enumeration: []string{"b"}}}}},
	}}
	validator := mustCompile(t, schema, nil)
	failure := validator.Validate(map[string]any{"kind": "c"})
	if failure == nil {
		t.Fatal("expected oneOf no-match failure")
	}

	var leafReasons []string
	var walk func(*Trace)
	walk = func(node *Trace) {
		if node == nil {
			return
		}
		if len(node.Children) == 0 && node.Failed() {
			leafReasons = append(leafReasons, node.Reason)
		}
		for _, child := range node.Children {
			walk(child)
		}
	}
	walk(failure.Trace)

	count := 0
	for _, reason := range leafReasons {
		if reason == ReasonEnumMismatch {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("expected two enum mismatch leaves across both branches, got %d", count)
	}
}
