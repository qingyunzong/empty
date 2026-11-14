package dataeng

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestJSONPartialUpdateUsesPreImageAsBase(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	_, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 7,
		After: RowImage{
			"id":   uint64(1),
			"name": "one",
			"qty":  uint64(1),
			"doc": map[string]any{
				"a":   float64(1),
				"b":   map[string]any{"c": float64(2)},
				"arr": []any{float64(1), float64(2)},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	row, err := p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(1)},
		AfterJSONDiffs: map[string]JSONDiff{
			"doc": NewJSONDiff(
				JSONOperation{Op: "replace", Path: "$.b.c", Value: float64(3)},
				JSONOperation{Op: "insert", Path: "$.arr[1]", Value: float64(9)},
				JSONOperation{Op: "remove", Path: "$.a"},
			),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !row.Reconstructable {
		t.Fatalf("row was not reconstructable: %+v", row)
	}
	want := map[string]any{
		"b":   map[string]any{"c": float64(3)},
		"arr": []any{float64(1), float64(9), float64(2)},
	}
	if !reflect.DeepEqual(row.Row["doc"], want) {
		t.Fatalf("json diff result = %#v, want %#v", row.Row["doc"], want)
	}
	if row.Row["name"] != "one" || row.Row["qty"] != uint64(1) {
		t.Fatalf("non-json columns changed: %#v", row.Row)
	}
}

func TestJSONPartialUpdateWithoutBaseIsNotZeroFilled(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	row, err := p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(42)},
		AfterJSONDiffs: map[string]JSONDiff{
			"doc": NewJSONDiff(JSONOperation{Op: "replace", Path: "$.a", Value: "x"}),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.Reconstructable {
		t.Fatalf("row should not be reconstructable: %+v", row)
	}
	if _, ok := row.Row["doc"]; ok {
		t.Fatalf("json column was fabricated without a base: %#v", row.Row["doc"])
	}
	if !contains(row.MissingColumns, "doc") {
		t.Fatalf("doc not listed as missing: %v", row.MissingColumns)
	}
}

func TestParseTextJSONPatch(t *testing.T) {
	patch := []byte(`[
		{"op":"replace","path":"/a","value":5},
		{"op":"add","path":"/b/-","value":true},
		{"op":"remove","path":"/c"}
	]`)
	diff, err := ParseJSONPatch(patch)
	if err != nil {
		t.Fatal(err)
	}
	base := map[string]any{"a": float64(1), "b": []any{}, "c": "delete"}
	got, err := ApplyJSONDiff(base, diff)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"a": float64(5), "b": []any{true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestJSONDiffFullValueDoesNotNeedBase(t *testing.T) {
	diff := JSONDiff{FullValue: map[string]any{"a": float64(1)}, HasFullValue: true}
	got, err := ApplyJSONDiff(nil, diff)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[string]any{"a": float64(1)}) {
		t.Fatalf("got %#v", got)
	}
}

func TestJSONPatchRootAndMerge(t *testing.T) {
	base := map[string]any{"a": map[string]any{"x": float64(1)}}
	got, err := ApplyJSONPatch(base, []JSONOperation{
		{Op: "merge", Path: "$.a", Value: map[string]any{"y": float64(2)}},
		{Op: "replace", Path: "$", Value: map[string]any{"done": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[string]any{"done": true}) {
		t.Fatalf("got %#v", got)
	}
}

func TestDecodeMySQLJSONDiff(t *testing.T) {
	value, err := EncodeMySQLJSONForTest("b")
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{jsonDiffReplace}
	payload = append(payload, byte(len("$.a")), 0)
	payload = append(payload, []byte("$.a")...)
	payload = append(payload, byte(len(value)), 0)
	payload = append(payload, value...)

	base := map[string]any{"a": "x", "keep": float64(1)}
	got, err := ApplyJSONPartialUpdate(base, payload)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"a": "b", "keep": float64(1)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestPartialJSONFlagStillAcceptsFullTextJSON(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	row, err := p.NormalizeRow(RowEvent{
		Type:        RowInsert,
		TableID:     7,
		PartialJSON: true,
		After: RowImage{
			"id":   uint64(1),
			"name": "one",
			"qty":  uint64(1),
			"doc":  []byte(`{"a":1}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !row.Reconstructable {
		t.Fatalf("full text json should be accepted: %+v", row)
	}
	if !reflect.DeepEqual(row.Row["doc"], map[string]any{"a": float64(1)}) {
		t.Fatalf("unexpected doc: %#v", row.Row["doc"])
	}
}

func EncodeMySQLJSONForTest(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return nil, err
	}
	switch typed := decoded.(type) {
	case string:
		return append([]byte{jsonbString, byte(len(typed))}, []byte(typed)...), nil
	default:
		return nil, errors.New("test encoder supports strings only")
	}
}
