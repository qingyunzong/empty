package dataeng

import (
	"encoding/json"
	"testing"
)

func optionalInt(name string, nullable bool, enum []int) FieldSpec {
	return FieldSpec{Name: name, Kind: IntegerEnum, Nullable: nullable, Enum: enum}
}

func requiredInt(name string, enum []int) FieldSpec {
	return FieldSpec{Name: name, Kind: IntegerEnum, Required: true, Enum: enum}
}

func arrayField(name string, enum []int, min, max int) FieldSpec {
	return FieldSpec{Name: name, Kind: EnumArray, Enum: enum, MinItems: min, MaxItems: max}
}

func mustCheck(t *testing.T, old, new *Schema) *Result {
	t.Helper()
	res, err := Check(old, new)
	if err != nil {
		t.Fatalf("Check returned error: %v", err)
	}
	return res
}

func TestNewRequiredField(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2})}}
	new := &Schema{Fields: []FieldSpec{
		optionalInt("a", false, []int{1, 2}),
		requiredInt("b", []int{7}),
	}}

	res := mustCheck(t, old, new)
	if res.Counterexample == nil {
		t.Fatal("expected counterexample for newly required field")
	}
	if got := res.Counterexample.Record.String(); got != "{}" {
		t.Fatalf("minimal record = %s, want {}", got)
	}
}

func TestNullTightening(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{optionalInt("a", true, []int{1, 2})}}
	new := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2})}}

	res := mustCheck(t, old, new)
	if res.Counterexample == nil {
		t.Fatal("expected counterexample for null tightening")
	}
	if got := res.Counterexample.Record.String(); got != `{"a":null}` {
		t.Fatalf("minimal record = %s, want {\"a\":null}", got)
	}
}

func TestArrayLengthTightening(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{arrayField("tags", []int{9}, 0, 3)}}
	new := &Schema{Fields: []FieldSpec{arrayField("tags", []int{9}, 0, 2)}}

	res := mustCheck(t, old, new)
	if res.Counterexample == nil {
		t.Fatal("expected counterexample for MaxItems tightening")
	}
	want := `{"tags":[9,9,9]}`
	if got := res.Counterexample.Record.String(); got != want {
		t.Fatalf("minimal record = %s, want %s", got, want)
	}
}

func TestArrayMinItemsTightening(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{arrayField("tags", []int{9}, 0, 3)}}
	new := &Schema{Fields: []FieldSpec{arrayField("tags", []int{9}, 1, 3)}}

	res := mustCheck(t, old, new)
	if res.Counterexample == nil {
		t.Fatal("expected counterexample for MinItems tightening")
	}
	want := `{"tags":[]}`
	if got := res.Counterexample.Record.String(); got != want {
		t.Fatalf("minimal record = %s, want %s", got, want)
	}
}

func TestEnumRestriction(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2})}}
	new := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1})}}

	res := mustCheck(t, old, new)
	if res.Counterexample == nil {
		t.Fatal("expected counterexample for enum restriction")
	}
	want := `{"a":2}`
	if got := res.Counterexample.Record.String(); got != want {
		t.Fatalf("minimal record = %s, want %s", got, want)
	}
}

func TestContainmentProof(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{
		optionalInt("a", true, []int{1, 2}),
		arrayField("tags", []int{9}, 0, 2),
	}}
	// New schema widens enum, keeps null and array bounds, adds an optional field.
	new := &Schema{Fields: []FieldSpec{
		optionalInt("a", true, []int{1, 2, 3}),
		arrayField("tags", []int{9, 8}, 0, 3),
		optionalInt("note", false, []int{0}),
	}}

	res := mustCheck(t, old, new)
	if res.Proof == nil || !res.Proof.Contained {
		t.Fatalf("expected containment proof, got %+v", res)
	}

	size, err := DomainSize(old)
	if err != nil {
		t.Fatalf("DomainSize error: %v", err)
	}
	// a: absent + null + 1 + 2 = 4 choices; tags: absent + arrays of
	// lengths 0..2 over a single value = 1 + (1 + 1 + 1) = 4 choices.
	if size != 16 {
		t.Fatalf("domain size = %d, want 16", size)
	}
	if res.Proof.Checked != size {
		t.Fatalf("checked = %d, want %d", res.Proof.Checked, size)
	}
	for _, fact := range res.Proof.FieldFacts {
		if !fact.Contained {
			t.Fatalf("field %s reported not contained: %s", fact.Field, fact.Detail)
		}
	}
}

func TestEnumOrderDrivesValueOrder(t *testing.T) {
	// Same two values, opposite caller order. The smallest rejected value
	// must follow each schema's own enum ranks rather than numeric order.
	oldAsc := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2, 3})}}
	oldDesc := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{3, 2, 1})}}
	new := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{3})}}

	asc := mustCheck(t, oldAsc, new)
	if got := asc.Counterexample.Record.String(); got != `{"a":1}` {
		t.Fatalf("ascending enum minimal record = %s, want {\"a\":1}", got)
	}
	desc := mustCheck(t, oldDesc, new)
	if got := desc.Counterexample.Record.String(); got != `{"a":2}` {
		t.Fatalf("descending enum minimal record = %s, want {\"a\":2}", got)
	}
}

func TestUnknownFieldRejected(t *testing.T) {
	s := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1})}}
	ok, err := Accept(s, Record{"unknown": IntValue(1)})
	if ok || err == nil {
		t.Fatal("unknown field must be rejected")
	}

	ok, err = Accept(s, Record{"a": IntValue(1)})
	if !ok || err != nil {
		t.Fatalf("valid record rejected: %v", err)
	}
}

func TestMissingIsNotAValue(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2})}}
	new := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2})}}

	rec := Record{}
	raw, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	if string(raw) != "{}" {
		t.Fatalf("empty record rendered as %s, want {}", raw)
	}

	res := mustCheck(t, old, new)
	if res.Proof == nil {
		t.Fatal("identical schemas must yield a proof")
	}
}

func TestOrderingByFieldCountThenKeySequence(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{
		optionalInt("a", false, []int{1}),
		optionalInt("b", false, []int{1}),
	}}
	// New schema accepts no single-field record of either key, but it also
	// rejects the empty record would be first; instead require both fields
	// so the first failure is the smallest key sequence ["a"].
	new := &Schema{Fields: []FieldSpec{
		{Name: "a", Kind: IntegerEnum, Required: true, Enum: []int{2}},
		{Name: "b", Kind: IntegerEnum, Required: true, Enum: []int{1}},
	}}

	res := mustCheck(t, old, new)
	if res.Counterexample == nil {
		t.Fatal("expected counterexample")
	}
	// Empty record fails first because both new fields are required.
	if got := res.Counterexample.Record.String(); got != "{}" {
		t.Fatalf("minimal record = %s, want {}", got)
	}

	// With an empty record accepted, one-field subsets must appear in
	// lexicographic key order, "a" before "b".
	new2 := &Schema{Fields: []FieldSpec{
		optionalInt("a", false, []int{2}),
		optionalInt("b", false, []int{1}),
	}}
	res2 := mustCheck(t, old, new2)
	if got := res2.Counterexample.Record.String(); got != `{"a":1}` {
		t.Fatalf("minimal record = %s, want {\"a\":1}", got)
	}
}

func TestValidationRejectsOversizedSchemas(t *testing.T) {
	fields := make([]FieldSpec, 9)
	for i := range fields {
		fields[i] = optionalInt(string(rune('a'+i)), false, []int{1})
	}
	if _, err := Check(&Schema{Fields: fields}, &Schema{Fields: fields[:8]}); err == nil {
		t.Fatal("expected error for schema with more than 8 fields")
	}

	badArray := &Schema{Fields: []FieldSpec{arrayField("tags", []int{1}, 0, 4)}}
	if _, err := DomainSize(badArray); err == nil {
		t.Fatal("expected error for MaxItems > 3")
	}
}

func TestEnumerationLimit(t *testing.T) {
	old := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2, 3})}}
	new := &Schema{Fields: []FieldSpec{optionalInt("a", false, []int{1, 2, 3})}}
	if _, err := CheckWithLimit(old, new, 2); err == nil {
		t.Fatal("expected limit error when domain exceeds the cap")
	}
	res, err := CheckWithLimit(old, new, 4)
	if err != nil || res.Proof == nil {
		t.Fatalf("domain of size 4 under cap 4 should pass, err=%v res=%+v", err, res)
	}
}
